// What ffmpeg.lock pins besides versions: the content each version stands for. A library released as git tags is
// pinned to the commit its tag names, a tarball (FFmpeg's own too) to its sha256. A library that follows a branch
// needs no pin: its version already is a commit.
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { basename, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { keepSource, sha256, SourceIntegrityError } from './build/fetch.ts';
import { expandTemplate, sourceOf } from './build/plan.ts';
import { UpstreamFailure } from './commands/versions.ts';
import { HttpError, netDefaults, NetTimeoutError } from './net.ts';
import { GitMissingError, gitRefCommit, mapLimit, withRetry } from './upstream.ts';

import type { EngineData } from './engine-data.ts';
import type { FolderLock, LockPins, SourcePin } from './lockfile.ts';

/** Pins asked upstream at once. */
const PIN_CONCURRENCY = 8;
const MS_PER_S = 1_000;
const HTTP_OK = 200;
const HTTP_REDIRECT_FIRST = 300;
const HTTP_REDIRECT_END = 400;
/** The defaults for a tarball download: 1 GiB at most, an hour in all (as a build's curl has). */
const MAX_TARBALL_BYTES = 1_073_741_824;
const DOWNLOAD_DEADLINE_MS = 3_600_000;

/** Where pins come from: a git ref's commit, and a tarball's sha256 (from the first of `urls` that answers). */
export interface PinSource {
  commitOf: (repo: string, ref: string) => Promise<string>;
  sha256Of: (name: string, urls: string[]) => Promise<string>;
}

/** The pin a library's source needs: a commit for a git tag, a sha256 for a tarball, none for a branch. */
export function requiredPin(data: EngineData, recipe: string): keyof SourcePin | undefined {
  const r = data.recipes.get(recipe)!;
  if ('url' in r.source) {
    return 'sha256';
  }
  return 'git-branch' in r.versions ? undefined : 'commit';
}

/** FFmpeg's tarball URLs for a version: the release tarball, then its mirrors. */
const ffmpegArchives = (data: EngineData, version: string) =>
  [data.ffmpegSource.url, ...data.ffmpegSource.mirrors].map((u) => expandTemplate(u, version));

/** What the lock has a version for but no pin of the kind its source needs: `FFmpeg 9.0.2`, `dav1d 1.5.4`. */
export function unpinnedSources(data: EngineData, lock: FolderLock): string[] {
  const ffmpeg = Object.entries(lock.ffmpeg)
    .filter(([series]) => !lock.pins?.ffmpeg[series]?.sha256)
    .map(([, v]) => `FFmpeg ${v}`);
  const libraries = Object.keys(lock.libraries)
    .sort()
    .filter((l) => {
      if (!data.recipes.has(l)) {
        return false;
      } // a recipe the engine no longer has: check says so elsewhere
      const need = requiredPin(data, l);
      return need !== undefined && !lock.pins?.libraries[l]?.[need];
    })
    .map((l) => `${l} ${lock.libraries[l] ?? ''}`);
  return [...new Set(ffmpeg), ...libraries];
}

/**
 * The pins for `lock`'s versions: the old lock's where the version (and the kind of pin) is unchanged, else asked
 * upstream. Fails with every source it couldn't pin, so nothing half-pinned is written.
 */
export async function pinLock(
  data: EngineData,
  lock: Omit<FolderLock, 'engine' | 'pins'>,
  old: FolderLock | undefined,
  source: PinSource,
): Promise<LockPins> {
  const pins: LockPins = { ffmpeg: {}, libraries: {} };
  const jobs: { what: string; run: () => Promise<void> }[] = [];
  const ffmpegShas = new Map<string, Promise<string>>(); // two series on one release download it once
  for (const [series, version] of Object.entries(lock.ffmpeg)) {
    const kept = old?.ffmpeg[series] === version ? old.pins?.ffmpeg[series]?.sha256 : undefined;
    if (kept) {
      pins.ffmpeg[series] = { sha256: kept };
    } else {
      jobs.push({
        what: `FFmpeg ${version}`,
        run: async () => {
          if (!ffmpegShas.has(version)) {
            ffmpegShas.set(version, source.sha256Of('ffmpeg', ffmpegArchives(data, version)));
          }
          pins.ffmpeg[series] = { sha256: await ffmpegShas.get(version)! };
        },
      });
    }
  }
  for (const [library, version] of Object.entries(lock.libraries).filter(([l]) =>
    data.recipes.has(l),
  )) {
    const need = requiredPin(data, library);
    const kept =
      need && old?.libraries[library] === version
        ? old.pins?.libraries[library]?.[need]
        : undefined;
    if (need && kept) {
      pins.libraries[library] = { [need]: kept };
    } else if (need) {
      const s = sourceOf(data, library, version);
      jobs.push({
        what: `${library} ${version}`,
        run: async () => {
          if ('archives' in s) {
            pins.libraries[library] = { sha256: await source.sha256Of(library, s.archives) };
          } else if ('ref' in s) {
            let commit: string;
            try {
              commit = await source.commitOf(s.git, s.ref);
            } catch (error) {
              if (!s.mirror || error instanceof GitMissingError) {
                throw error;
              }
              commit = await source.commitOf(s.mirror, s.ref);
            }
            pins.libraries[library] = { commit };
          }
        },
      });
    }
  }
  const results = await mapLimit(jobs, PIN_CONCURRENCY, async (job) => job.run());
  const failures: string[] = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      return;
    }
    if (result.reason instanceof GitMissingError) {
      throw result.reason;
    }
    failures.push(
      `${jobs[i]!.what}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
    );
  });
  if (failures.length) {
    throw new UpstreamFailure(failures.map((f) => `couldn't pin ${f}`));
  }
  return pins;
}

/** Bounds on a tarball download (the defaults suit any source tarball; tests make them small). */
export interface DownloadLimits {
  /** The most it may be, in bytes (default 1 GB: FFmpeg's tarball is about 20 MB). */
  maxBytes?: number;
  /** The whole download's deadline, redirects included (default 60 min, as a build's curl has). */
  deadlineMs?: number;
  /** The longest wait for the next data (default the network timeout, 60 s: FFMPEG_BUILD_NET_TIMEOUT_MS). */
  idleMs?: number;
  /** Waits between attempts (default 250 ms, 1 s: three attempts). */
  retryDelays?: number[];
}

/** A download over its size cap: retrying won't help. */
class DownloadTooLargeError extends Error {
  readonly permanent = true;
}

/**
 * Downloads `url` (http(s), following redirects, or a file: URL) to `to`, within `limits`. node:http rather than
 * fetch: undici's parser can trip an internal assertion and end the process when a server closes a slow-draining
 * download.
 */
async function download(
  url: string,
  to: string,
  limits: Required<Omit<DownloadLimits, 'retryDelays'>>,
  deadline = Date.now() + limits.deadlineMs,
  redirects = 10,
): Promise<void> {
  const tooLarge = () =>
    new DownloadTooLargeError(
      `larger than ${String(limits.maxBytes)} bytes; is this really a source tarball?`,
    );
  const late = () =>
    new NetTimeoutError(`took longer than ${String(limits.deadlineMs / MS_PER_S)} s`);
  // passes the bytes through, failing once there are more than maxBytes
  const capped = () => {
    let got = 0;
    return new Transform({
      transform(chunk: Buffer, _enc, done) {
        got += chunk.length;
        done(got > limits.maxBytes ? tooLarge() : null, chunk);
      },
    });
  };
  const left = deadline - Date.now();
  if (left <= 0) {
    throw late();
  }
  if (url.startsWith('file:')) {
    // the same bounds as a server's: a file can be huge, or never end (a FIFO, a device)
    const path = fileURLToPath(url);
    if (statSync(path).size > limits.maxBytes) {
      throw tooLarge();
    }
    const input = createReadStream(path);
    const timer = setTimeout(() => {
      input.destroy(late());
    }, left);
    try {
      await pipeline(input, capped(), createWriteStream(to));
    } finally {
      clearTimeout(timer);
    }
    return;
  }
  let req: ReturnType<typeof httpGet> | undefined;
  let response: IncomingMessage | undefined;
  // fails the request, or the body once it is streaming (destroying only the request would surface as "aborted")
  const fail = (e: Error) => {
    if (response) {
      response.destroy(e);
    } else {
      req?.destroy(e);
    }
  };
  const timer = setTimeout(() => fail(late()), left);
  try {
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      // `timeout` is the socket's idle time: no connection, no answer, or no data for that long
      req = (url.startsWith('https:') ? httpsGet : httpGet)(
        url,
        { timeout: limits.idleMs },
        (r) => {
          response = r;
          resolve(r);
        },
      );
      req.on('timeout', () =>
        fail(new NetTimeoutError(`no data for ${String(limits.idleMs / MS_PER_S)} s`)),
      );
      req.on('error', reject);
    });
    const status = res.statusCode ?? 0;
    if (status >= HTTP_REDIRECT_FIRST && status < HTTP_REDIRECT_END && res.headers.location) {
      res.resume();
      if (!redirects) {
        throw new Error('too many redirects');
      }
      clearTimeout(timer);
      await download(new URL(res.headers.location, url).href, to, limits, deadline, redirects - 1);
      return;
    }
    if (status !== HTTP_OK) {
      res.resume();
      throw new HttpError(status, `HTTP ${String(status)}`); // withRetry tries again only where that could help (net.ts)
    }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > limits.maxBytes) {
      res.destroy();
      throw tooLarge();
    }
    await pipeline(res, capped(), createWriteStream(to));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pins from upstream: `git ls-remote` for a ref's commit; a tarball downloaded once and kept in the cache's
 * `sources` folder, where a build finds it (and checks it against the pin) instead of downloading it again.
 */
export function defaultPinSource(sources: string, limits: DownloadLimits = {}): PinSource {
  const bounds = {
    maxBytes: limits.maxBytes ?? MAX_TARBALL_BYTES,
    deadlineMs: limits.deadlineMs ?? DOWNLOAD_DEADLINE_MS,
    idleMs: limits.idleMs ?? netDefaults().timeoutMs,
  };
  return {
    commitOf: async (repo, ref) => withRetry(async () => gitRefCommit(repo, ref)),
    async sha256Of(name, urls) {
      const errors: string[] = [];
      for (const url of urls) {
        const kept = `${name}/${basename(new URL(url).pathname)}`;
        mkdirSync(join(sources, name), { recursive: true });
        const temp = mkdtempSync(join(sources, name, '.download-'));
        try {
          const file = join(temp, 'download');
          await withRetry(async () => download(url, file, bounds), limits.retryDelays);
          keepSource(sources, kept, file); // a different copy kept earlier is an error, as in a build
          return sha256(file);
        } catch (error) {
          if (error instanceof SourceIntegrityError) {
            throw error;
          }
          errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          rmSync(temp, { recursive: true, force: true });
        }
      }
      throw new Error(`couldn't download it (${errors.join('; ')})`);
    },
  };
}
