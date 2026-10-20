// `ffmpeg-build fetch`: a product takes a published build instead of building FFmpeg. The pin is one line,
// `owner/repo@tag`; the release's manifest.yml says which assets a target has and their sha256.
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { writeFileAtomic } from './atomic-write.ts';
import { acquireLock, type HeldLock, LockBusyError } from './file-lock.ts';
import { type Manifest, MANIFEST_FILE, type ManifestTarget, parseManifest } from './manifest.ts';
import {
  HttpError,
  isNetworkFailure,
  netDefaults,
  type NetRetryOptions,
  NetTimeoutError,
  withNetRetry,
} from './net.ts';
import { releaseVersion } from './targets.ts';
import { extractTarGzFile, mergeInto, UnsafeArchiveError } from './untar.ts';

/** The exit codes a fetch fails with (docs/getting-started.md): 1 for a problem with the release, 2 for data or the network. */
const EXIT_PROBLEM = 1;
const EXIT_DATA = 2;
type FetchExitCode = typeof EXIT_PROBLEM | typeof EXIT_DATA;

const MS_PER_S = 1_000;
const MIB = 1_048_576;
const HTTP_NOT_FOUND = 404;
/** The most releases GitHub lists on one page. */
const RELEASES_PER_PAGE = 100;
const JSON_INDENT = 2;

/** Ends a stream nobody will read; a failure to do so changes nothing. */
const ignore = (): void => undefined;

export class FetchError extends Error {
  readonly exitCode: FetchExitCode;
  constructor(message: string, exitCode: FetchExitCode = EXIT_DATA) {
    super(message);
    this.exitCode = exitCode;
  }
}

export interface Pin {
  repo: string;
  tag: string;
}
const STAMP = '.ffmpeg-build-fetch';

export function parsePin(text: string): Pin {
  const m = /^\s*([\w.-]+\/[\w.-]+)@(\S+)\s*$/.exec(text);
  if (!m || m[1]!.split('/').some((part) => /^\.+$/.test(part))) {
    throw new FetchError(
      `"${text.trim()}" is not a release pin; write it as owner/repo@tag: the repository that publishes the builds, and one of its release tags`,
    );
  }
  return { repo: m[1]!, tag: m[2]! };
}

const api = () =>
  (process.env['FFMPEG_BUILD_GITHUB_API'] ?? 'https://api.github.com').replace(/\/$/, '');
const token = () => process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];

const local = (u: URL) => u.hostname === '127.0.0.1' || u.hostname === 'localhost';

/** One request (no retry): network failures are thrown as they are, for withNetRetry to judge. */
async function get(url: string, accept: string, signal: AbortSignal): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && !local(u)) {
    throw new FetchError(`refusing to download over ${u.protocol} (${u.host}); only https`);
  }
  const headers: Record<string, string> = { accept, 'user-agent': 'ffmpeg-build' };
  // the token is for the API; an asset URL on another host (or a redirect to one) never gets it
  const t = token();
  if (t && u.origin === new URL(api()).origin) {
    headers['authorization'] = `Bearer ${t}`;
  }
  return fetch(url, { headers, redirect: 'follow', signal });
}

const describeNetError = (e: unknown) => {
  const err = e as Error & { cause?: { message?: string; code?: string } };
  return err.cause?.code ?? err.cause?.message ?? err.message;
};

/**
 * A request with bounded retries (net.ts): `attempt` makes it and reads the answer. What still fails is a FetchError
 * (exit 2) naming the host, the cause and how many attempts were made.
 */
async function withRetries<T>(
  url: string,
  attempt: (signal: AbortSignal) => Promise<T>,
  options: NetRetryOptions = {},
): Promise<T> {
  let attempts = 1;
  try {
    return await withNetRetry(attempt, {
      ...options,
      onRetry: (_e, n) => {
        attempts = n + 1;
      },
    });
  } catch (e) {
    if (e instanceof FetchError) {
      throw e;
    }
    const tries = attempts > 1 ? ` (${String(attempts)} attempts)` : '';
    if (e instanceof HttpError) {
      throw new FetchError(`${e.message}${tries}`);
    }
    if (isNetworkFailure(e)) {
      throw new FetchError(`couldn't reach ${new URL(url).host}: ${describeNetError(e)}${tries}`);
    }
    throw e;
  }
}

async function json<T>(url: string, what: string): Promise<T> {
  return withRetries(url, async (signal) => {
    const res = await get(url, 'application/vnd.github+json', signal);
    if (res.status === HTTP_NOT_FOUND) {
      throw new FetchError(
        `${what} not found${token() ? '' : ' (a private repository needs GITHUB_TOKEN or GH_TOKEN)'}`,
      );
    }
    if (!res.ok) {
      await res.body?.cancel().catch(ignore);
      throw new HttpError(res.status, `${what}: GitHub answered ${String(res.status)}`);
    }
    const text = await res.text(); // a dropped connection here is the network's, and retried
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new FetchError(
        `${what}: GitHub's answer was cut short or not JSON (${(e as Error).message})`,
      );
    }
  });
}

interface ReleaseAsset {
  name: string;
  url: string;
}
export interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

async function release(pin: Pin): Promise<Release> {
  return json<Release>(
    `${api()}/repos/${pin.repo}/releases/tags/${encodeURIComponent(pin.tag)}`,
    `release ${pin.repo}@${pin.tag}`,
  );
}

/** An asset download's deadline per attempt: generous, since stalls are caught by the idle timeout instead. */
const ASSET_DEADLINE_MS = 7_200_000; // two hours

/**
 * Streams one asset of a release to `onChunk`, retried as a whole (`onStart` is called before each attempt, to start
 * over). An attempt fails when no data arrives for the network timeout (60 s). FetchError (exit 1) when the release
 * has no such asset.
 */
async function streamAsset(
  pin: Pin,
  rel: Release,
  name: string,
  onStart: () => void,
  onChunk: (chunk: Uint8Array) => void,
): Promise<void> {
  const a = rel.assets.find((x) => x.name === name);
  if (!a) {
    throw new FetchError(`${pin.repo}@${pin.tag} has no asset ${name}`, EXIT_PROBLEM);
  }
  const idleMs = netDefaults().timeoutMs;
  await withRetries(
    a.url,
    async (signal) => {
      onStart();
      const idle = new AbortController();
      let timer = setTimeout(
        () => idle.abort(new NetTimeoutError(`no data for ${String(idleMs / MS_PER_S)} s`)),
        idleMs,
      );
      const kick = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => idle.abort(new NetTimeoutError(`no data for ${String(idleMs / MS_PER_S)} s`)),
          idleMs,
        );
      };
      try {
        const res = await get(
          a.url,
          'application/octet-stream',
          AbortSignal.any([signal, idle.signal]),
        );
        if (!res.ok) {
          await res.body?.cancel().catch(ignore);
          throw new HttpError(
            res.status,
            `downloading ${name}: GitHub answered ${String(res.status)}`,
          );
        }
        kick();
        if (res.body) {
          for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
            kick();
            onChunk(chunk);
          }
        }
      } catch (e) {
        if (idle.signal.aborted) {
          throw idle.signal.reason;
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
    { timeoutMs: ASSET_DEADLINE_MS },
  );
}

/** The most a small asset (manifest.yml, a slices record) may hold, read into memory. */
const SMALL_ASSET_MAX = 16_777_216; // 16 MiB

/** One small asset of a release (an archive goes to a file: downloadTo), in memory; FetchError (exit 1) when the release has no such asset. */
export async function download(pin: Pin, rel: Release, name: string): Promise<Buffer> {
  let parts: Uint8Array[] = [];
  let size = 0;
  await streamAsset(
    pin,
    rel,
    name,
    () => {
      parts = [];
      size = 0;
    },
    (chunk) => {
      size += chunk.length;
      if (size > SMALL_ASSET_MAX) {
        throw new FetchError(
          `${name} is larger than ${String(SMALL_ASSET_MAX / MIB)} MB; that isn't one ffmpeg-build wrote`,
        );
      }
      parts.push(chunk);
    },
  );
  return Buffer.concat(parts);
}

export async function readManifest(pin: Pin): Promise<{ release: Release; manifest: Manifest }> {
  const rel = await release(pin);
  // no manifest: not a release ffmpeg-build published (a data problem, exit 2; release-remote reads this message)
  if (!rel.assets.some((a) => a.name === MANIFEST_FILE)) {
    throw new FetchError(
      `${pin.repo}@${pin.tag} has no asset ${MANIFEST_FILE}: it isn't a release ffmpeg-build published`,
      EXIT_DATA,
    );
  }
  const text = (await download(pin, rel, MANIFEST_FILE)).toString('utf8');
  try {
    return {
      release: rel,
      manifest: parseManifest(text, `${pin.repo}@${pin.tag} ${MANIFEST_FILE}`),
    };
  } catch (e) {
    throw new FetchError((e as Error).message);
  }
}

/** The target `--target` names, or the only one on `--platform`. */
function pickTarget(m: Manifest, sel: { target?: string; platform?: string }): ManifestTarget {
  const names = m.targets.map((t) => t.name).join(', ');
  if (sel.target) {
    const t = m.targets.find((x) => x.name === sel.target);
    if (!t) {
      throw new FetchError(
        `release ${m.release} has no target ${sel.target} (it has ${names})`,
        EXIT_PROBLEM,
      );
    }
    return t;
  }
  if (sel.platform) {
    const on = m.targets.filter((x) => x.platform === sel.platform);
    if (on.length === 1) {
      return on[0]!;
    }
    if (!on.length) {
      throw new FetchError(
        `release ${m.release} has nothing for ${sel.platform} (it has ${names})`,
        EXIT_PROBLEM,
      );
    }
    throw new FetchError(
      `release ${m.release} has ${on.length} targets for ${sel.platform}; name one with --target (${on.map((t) => t.name).join(', ')})`,
    );
  }
  throw new FetchError(
    'say what to fetch: --target <name> (or --platform <platform> when the release has one target for it)',
  );
}

interface Stamp {
  pin: string;
  target: string;
  dev: boolean;
  sha256: string[];
}

function readStamp(path: string): Stamp | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Stamp;
  } catch {
    return undefined; // unreadable: treated as a folder fetch made, so it is replaced
  }
}

/**
 * Whether `out` may be replaced: it doesn't exist, is empty, or holds an earlier fetch. Never the current folder, one
 * of its parents or a root, whatever is in them.
 */
function checkOut(target: string): void {
  const cwd = resolve('.');
  const rel = relative(target, cwd);
  if (target === dirname(target) || rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new FetchError(
      `--out ${target} is this folder or one that holds it; fetch replaces --out whole, so name a folder of its own (e.g. --out ffmpeg)`,
    );
  }
  if (!existsSync(target)) {
    return;
  }
  if (!statSync(target).isDirectory()) {
    throw new FetchError(`--out ${target} is a file; name a folder`);
  }
  if (readdirSync(target).length && !existsSync(join(target, STAMP))) {
    throw new FetchError(
      `--out ${target} already holds files fetch didn't put there; fetch replaces --out whole, so name an empty or new folder`,
    );
  }
}

/**
 * Downloads a target's archives, checks them against the manifest, and unpacks them into `out` (runtime, plus dev
 * with `dev`). `out` is swapped in whole, so it holds exactly that release. A repeat run is a no-op: it trusts the
 * stamp and doesn't re-check the files.
 */
export async function fetchRelease(
  pinText: string,
  sel: { target?: string; platform?: string; dev?: boolean },
  out: string,
): Promise<string> {
  const pin = parsePin(pinText);
  const target = resolve(out);
  checkOut(target);
  const parent = dirname(target);
  const name = basename(target);
  mkdirSync(parent, { recursive: true });
  // one fetch into an --out at a time: a second waits for nothing and says so
  let lock: HeldLock;
  try {
    lock = acquireLock(join(parent, `.${name}.fetch.lock`), `fetching into ${out}`);
  } catch (e) {
    if (e instanceof LockBusyError) {
      throw new FetchError(
        `another ffmpeg-build fetch is unpacking into ${out}${e.pid ? ` (pid ${e.pid})` : ''}; wait for it to finish`,
      );
    }
    throw e;
  }
  try {
    recoverOut(parent, name, target);
    checkOut(target);
    return await fetchLocked(pin, sel, out, target, parent, name);
  } finally {
    lock.release();
  }
}

async function fetchLocked(
  pin: Pin,
  sel: { target?: string; platform?: string; dev?: boolean },
  out: string,
  target: string,
  parent: string,
  name: string,
): Promise<string> {
  const { release: rel, manifest } = await readManifest(pin);
  const t = pickTarget(manifest, sel);
  // by name: an ios entry's runtime and dev are the same file, downloaded and unpacked once
  const assets = [t.assets.runtime, ...(sel.dev ? [t.assets.dev] : [])].filter(
    (a, i, all) => all.findIndex((b) => b.name === a.name) === i,
  );
  const stamp: Stamp = {
    pin: `${pin.repo}@${pin.tag}`,
    target: t.name,
    dev: sel.dev === true,
    sha256: assets.map((a) => a.sha256),
  };
  const was = readStamp(join(target, STAMP));
  if (was?.pin === stamp.pin && was.target === stamp.target && was.dev === stamp.dev) {
    if (JSON.stringify(was.sha256) !== JSON.stringify(stamp.sha256)) {
      throw new FetchError(
        `${stamp.pin} changed since it was fetched (its checksums differ); release tags must not be reused`,
        EXIT_PROBLEM,
      );
    }
    return `${out}: already ${t.name} from ${stamp.pin}`;
  }
  // everything happens in a folder of this run's own beside --out: the downloads, then each archive unpacked
  const work = mkdtempSync(join(parent, `.${name}.fetching-`));
  try {
    const files: string[] = [];
    for (const [i, a] of assets.entries()) {
      const file = join(work, `download-${i}`);
      const got = await downloadTo(pin, rel, a.name, file);
      if (got !== a.sha256) {
        throw new FetchError(
          `${a.name}: checksum mismatch (expected ${a.sha256}, got ${got}); nothing was unpacked`,
          EXIT_PROBLEM,
        );
      }
      files.push(file);
    }
    const unpacked = files.map((_, i) => join(work, `unpacked-${i}`));
    try {
      // each archive unpacks on its own, then merges: one archive's links can never be followed by the other's entries
      for (const [i, file] of files.entries()) {
        await extractTarGzFile(file, unpacked[i]!);
      }
      for (const extra of unpacked.slice(1)) {
        mergeInto(extra, unpacked[0]!);
      }
      writeFileSync(join(unpacked[0]!, STAMP), `${JSON.stringify(stamp, null, JSON_INDENT)}\n`);
      // the swap: the earlier fetch steps aside under this run's own name, then goes once the new one is in place
      const old = join(parent, `.${name}.old-${basename(work).slice(`.${name}.fetching-`.length)}`);
      if (existsSync(target)) {
        renameSync(target, old);
      }
      try {
        renameSync(unpacked[0]!, target);
      } catch (e) {
        if (existsSync(old) && !existsSync(target)) {
          renameSync(old, target);
        }
        throw e;
      }
      rmSync(old, { recursive: true, force: true });
    } catch (e) {
      if (e instanceof UnsafeArchiveError) {
        throw new FetchError(`refusing to unpack ${t.name}: ${e.message}`, EXIT_PROBLEM);
      }
      throw new FetchError(`couldn't unpack ${t.name} into ${out}: ${(e as Error).message}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return `${out}: ${t.name} from ${stamp.pin}${sel.dev ? ' (with the dev archive)' : ''}`;
}

/**
 * Streams an asset to `file` (started over on a retry), hashing it on the way; resolves to its sha256. The download
 * is never held in memory.
 */
async function downloadTo(pin: Pin, rel: Release, asset: string, file: string): Promise<string> {
  let fd: number | undefined;
  let hash = createHash('sha256');
  try {
    await streamAsset(
      pin,
      rel,
      asset,
      () => {
        if (fd !== undefined) {
          closeSync(fd);
        }
        fd = openSync(file, 'w');
        hash = createHash('sha256');
      },
      (chunk) => {
        writeSync(fd!, chunk);
        hash.update(chunk);
      },
    );
    fsyncSync(fd!);
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
  return hash.digest('hex');
}

/**
 * Under the --out lock: puts back an earlier fetch a run that died mid-swap left aside (when --out is missing), then
 * clears every leftover of earlier runs: their work folders and set-aside copies.
 */
function recoverOut(parent: string, name: string, target: string): void {
  if (!existsSync(parent)) {
    return;
  }
  const prefix = `.${name}.`;
  // (.old, .fetching and .fetching.<n> are what runs before unique names left)
  const leftovers = readdirSync(parent).filter(
    (f) =>
      f === `${prefix}old` ||
      f.startsWith(`${prefix}old-`) ||
      f === `${prefix}fetching` ||
      f.startsWith(`${prefix}fetching-`) ||
      f.startsWith(`${prefix}fetching.`),
  );
  const asides = leftovers.filter((f) => f === `${prefix}old` || f.startsWith(`${prefix}old-`));
  if (!existsSync(target) && asides.length) {
    const newest = asides
      .map((f) => ({ f, at: statSync(join(parent, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]!.f;
    renameSync(join(parent, newest), target);
  }
  for (const f of leftovers) {
    rmSync(join(parent, f), { recursive: true, force: true });
  }
}

/** Every release of a repository, every page of them. */
export async function listReleases(repo: string): Promise<Release[]> {
  const all: Release[] = [];
  for (let page = 1; ; page++) {
    const list = await json<Release[]>(
      `${api()}/repos/${repo}/releases?per_page=${String(RELEASES_PER_PAGE)}&page=${String(page)}`,
      `releases of ${repo}`,
    );
    all.push(...list);
    if (list.length < RELEASES_PER_PAGE) {
      return all;
    }
  }
}

/**
 * `<group>-<ffmpeg>.<build>` or `<ffmpeg>.<build>`: the group, the FFmpeg version and the build number. The version
 * has three parts (an x.y release is tagged x.y.0.<build>: releaseVersion), so a tag ffmpeg-build makes has four.
 */
export function parseTag(
  tag: string,
): { group: string; ffmpeg: string; build: number } | undefined {
  const m = /^(?:(.+)-)?(\d+\.\d+(?:\.\d+)?)\.(\d+)$/.exec(tag);
  // a three-part tag is an x.y release from before tags were padded (10.0.3: FFmpeg 10.0, build 3); it still counts,
  // as 10.0.0 build 3, so the next build is 10.0.0.4
  return m ? { group: m[1] ?? '', ffmpeg: releaseVersion(m[2]!), build: Number(m[3]) } : undefined;
}

const versionKey = (v: { ffmpeg: string; build: number }) => {
  const parts = v.ffmpeg.split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, v.build];
};
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      return (a[i] ?? 0) > (b[i] ?? 0);
    }
  }
  return false;
};

/** Sorts version keys newest first. */
const newestFirst = (a: number[], b: number[]) => {
  if (newer(a, b)) {
    return -1;
  }
  return newer(b, a) ? 1 : 0;
};

/** A release's manifest; undefined when it has none it can read (a release without one isn't one to move to). */
async function manifestIfReadable(pin: Pin): Promise<Manifest | undefined> {
  try {
    return (await readManifest(pin)).manifest;
  } catch (e) {
    if (e instanceof FetchError) {
      return undefined;
    }
    throw e;
  }
}

/**
 * `fetch --update`: the newest published release of the same group and FFmpeg major that has the target. Drafts and
 * prereleases are skipped. Rewrites the pin file; returns what changed (for a PR body), or undefined when current.
 */
export async function updatePin(
  pinFile: string,
  sel: { target?: string; platform?: string },
): Promise<string | undefined> {
  let text: string;
  try {
    text = readFileSync(pinFile, 'utf8');
  } catch {
    throw new FetchError(`can't read the pin file ${pinFile}`);
  }
  const pin = parsePin(text);
  const now = parseTag(pin.tag);
  if (!now) {
    throw new FetchError(
      `${pin.tag} isn't a release tag ffmpeg-build made (<ffmpeg>.<build> or <group>-<ffmpeg>.<build>)`,
    );
  }
  const { manifest } = await readManifest(pin);
  const target = pickTarget(manifest, sel).name;
  const candidates: { tag: string; key: number[] }[] = [];
  for (const r of await listReleases(pin.repo)) {
    const t = parseTag(r.tag_name);
    if (
      !r.draft &&
      !r.prerelease &&
      t?.group === now.group &&
      t.ffmpeg.split('.')[0] === now.ffmpeg.split('.')[0] &&
      newer(versionKey(t), versionKey(now))
    ) {
      candidates.push({ tag: r.tag_name, key: versionKey(t) });
    }
  }
  candidates.sort((a, b) => newestFirst(a.key, b.key));
  for (const c of candidates) {
    const next = { repo: pin.repo, tag: c.tag };
    const m = await manifestIfReadable(next);
    if (m?.targets.some((t) => t.name === target)) {
      try {
        writeFileAtomic(pinFile, `${next.repo}@${next.tag}\n`);
      } catch (e) {
        throw new FetchError(`couldn't write the pin file ${pinFile}: ${(e as Error).message}`);
      }
      return `FFmpeg build ${pin.tag} -> ${next.tag} (${target}, ${pin.repo})`;
    }
  }
  return undefined;
}

/** Whether a repository is private, as the GitHub API says (a token is needed to see a private one at all). */
export async function repoIsPrivate(repo: string): Promise<boolean> {
  return (await json<{ private: boolean }>(`${api()}/repos/${repo}`, `repository ${repo}`)).private;
}

const HTTP_UNAUTHORIZED = 401;

/**
 * Whether git's smart HTTP on `server` (https://github.com) serves `repo` without credentials, which needs no API
 * rate limit: a public repository's refs come back (200, a git-upload-pack advertisement); any other repository asks
 * for credentials (401), and is taken as private (it may also not exist: a written offer of the source is then the
 * careful answer). Anything else is a FetchError.
 */
export async function repoIsPrivateByGit(server: string, repo: string): Promise<boolean> {
  const url = `${server.replace(/\/$/, '')}/${repo}.git/info/refs?service=git-upload-pack`;
  return withRetries(url, async (signal) => {
    const res = await get(url, '*/*', signal);
    await res.body?.cancel().catch(ignore);
    if (res.status === HTTP_UNAUTHORIZED) {
      return true;
    }
    if (
      res.ok &&
      res.headers.get('content-type') === 'application/x-git-upload-pack-advertisement'
    ) {
      return false;
    }
    throw new HttpError(
      res.status,
      `${repo}'s git refs: ${new URL(url).host} answered ${String(res.status)}`,
    );
  });
}

/** Whether FFmpeg version `a` is at least `b` (as three parts: 9.0 is 9.0.0). */
export function ffmpegAtLeast(a: string, b: string): boolean {
  return !newer(versionKey({ ffmpeg: b, build: 0 }), versionKey({ ffmpeg: a, build: 0 }));
}
