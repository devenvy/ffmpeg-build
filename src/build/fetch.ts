import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';

import { retry, run } from './run.ts';
import { readFileIfPresent } from '../read-file.ts';
import { listTarGzMembers } from '../untar.ts';

import type { CrateRecord, RustRecord } from './cargo.ts';
import type { Source } from './plan.ts';
import type { Submodules } from '../schema/engine.ts';

export interface SourceRecord {
  name: string;
  version: string;
  origin: string;
  file: string;
  sha256: string;
  commit?: string;
  cached?: boolean;
  crates?: CrateRecord[]; // a Rust library: the crates its build compiled (build/cargo.ts)
  rust?: RustRecord; // a Rust library: the standard library it links
}

/** Every file a source record keeps under the cache's sources/: its own source, and its crates' .crate files. */
export function keptFiles(record: {
  file: string;
  sha256: string;
  crates?:
    readonly { name: string; file?: string | undefined; sha256?: string | undefined }[] | undefined;
}): { file: string; sha256: string }[] {
  return [
    { file: record.file, sha256: record.sha256 },
    ...(record.crates ?? []).flatMap((c) =>
      c.file && c.sha256 ? [{ file: c.file, sha256: c.sha256 }] : [],
    ),
  ];
}

export interface FetchedSource {
  origin: string;
  kept: string;
  commit?: string;
}

export class SourceIntegrityError extends Error {}

export function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function placeOnce(temp: string, final: string): void {
  try {
    linkSync(temp, final);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

export function keepSource(sources: string, kept: string, downloaded: string): void {
  const final = join(sources, kept);
  if (!existsSync(final)) {
    mkdirSync(dirname(final), { recursive: true });
    const tempDir = mkdtempSync(`${final}.tmp.`);
    const temp = join(tempDir, 'source');
    copyFileSync(downloaded, temp);
    try {
      placeOnce(temp, final);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
  if (sha256(final) !== sha256(downloaded)) {
    throw new SourceIntegrityError(
      `the download of ${kept} differs from the copy the cache kept earlier (sha256 ${sha256(final)}); if upstream really replaced it, delete sources/${kept} from the cache folder (\`ffmpeg-build cache path\`), then \`ffmpeg-build cache verify --fix\` removes the library entries built from it; build again`,
    );
  }
}

type GitSource = Exclude<Source, { archives: string[] }>;

/** curl for a source archive: a connect timeout, an overall deadline, and a floor on speed (1 KB/s for a minute). */
export function curlArgs(url: string, to: string): string[] {
  return [
    '-fsSL',
    '--connect-timeout',
    '30',
    '--max-time',
    '3600',
    '--speed-limit',
    '1024',
    '--speed-time',
    '60',
    url,
    '-o',
    to,
  ];
}

/** A download that failed with an answer that won't change (a 4xx other than 408/429): not worth retrying. */
export function notWorthRetrying(error: unknown): boolean {
  const status = /returned error: (\d{3})/.exec(
    error instanceof Error ? error.message : String(error),
  )?.[1];
  return status !== undefined && status.startsWith('4') && status !== '408' && status !== '429';
}

/** How long a git network step may take before it is killed: an hour. */
const GIT_DEADLINE_MS = 3_600_000;
/** Tries at each archive URL; a git source gets more (fewer when a mirror is there to fall back on). */
const ARCHIVE_ATTEMPTS = 3;
const GIT_ATTEMPTS = 6;
const GIT_ATTEMPTS_BEFORE_MIRROR = 2;

/**
 * How git runs for a clone, fetch or submodule update: never prompting, a floor on speed (1 KB/s for a minute), and a
 * deadline after which it is killed.
 */
export function gitNetwork(env: NodeJS.ProcessEnv = process.env): {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
} {
  return {
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_HTTP_LOW_SPEED_LIMIT: '1000',
      GIT_HTTP_LOW_SPEED_TIME: '60',
    },
    timeoutMs: GIT_DEADLINE_MS,
  };
}

async function clone(url: string, source: GitSource, dest: string): Promise<void> {
  rmSync(dest, { recursive: true, force: true });
  const net = gitNetwork();
  if ('ref' in source) {
    await run('git', ['clone', '-q', '--depth', '1', '--branch', source.ref, '--', url, dest], net);
    return;
  }
  mkdirSync(dest, { recursive: true });
  await run('git', ['init', '-q', dest]);
  try {
    await run('git', ['-C', dest, 'fetch', '-q', '--depth', '1', '--', url, source.commit], net);
    await run('git', ['-C', dest, 'checkout', '-q', 'FETCH_HEAD']);
  } catch {
    rmSync(dest, { recursive: true, force: true });
    await run('git', ['clone', '-q', '--', url, dest], net);
    await run('git', ['-C', dest, 'checkout', '-q', '--detach', source.commit]);
  }
}

async function unpack(archive: string, dest: string): Promise<void> {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  await run('tar', ['-xf', archive, '-C', dest, '--strip-components=1']);
}

const keptName = (name: string, url: string) => `${name}/${basename(new URL(url).pathname)}`;

export async function fetchSource(
  source: Source,
  dest: string,
  name: string,
  sources: string,
  work: string,
): Promise<FetchedSource> {
  if ('archives' in source) {
    const pin = source.sha256;
    // a copy with the pinned content is already kept (lock downloaded it to pin it): no second download
    if (pin) {
      for (const url of source.archives) {
        const kept = keptName(name, url);
        if (existsSync(join(sources, kept)) && sha256(join(sources, kept)) === pin) {
          await unpack(join(sources, kept), dest);
          return { origin: url, kept };
        }
      }
    }
    const download = join(work, `download-${process.pid}`);
    const mismatches: string[] = [];
    for (const url of source.archives) {
      try {
        await retry(
          ARCHIVE_ATTEMPTS,
          async () => run('curl', curlArgs(url, download), { capture: true }),
          (e) => !notWorthRetrying(e),
        );
        // checked before anything is unpacked or kept: from any mirror, only the pinned content is taken
        const got = pin ? sha256(download) : undefined;
        if (pin && got !== pin) {
          mismatches.push(`${url} has sha256 ${String(got)}`);
          process.stderr
            .write(`  ${url} isn't the content ffmpeg.lock pins (sha256 ${String(got)}, not ${pin}); trying the next one
`);
        } else {
          await unpack(download, dest);
          const kept = keptName(name, url);
          keepSource(sources, kept, download);
          rmSync(download, { force: true });
          return { origin: url, kept };
        }
      } catch (error) {
        if (error instanceof SourceIntegrityError) {
          throw error;
        }
        process.stderr.write(`  ${url} unavailable; trying the next one\n`);
      }
    }
    rmSync(download, { force: true });
    rmSync(dest, { recursive: true, force: true });
    if (mismatches.length) {
      throw new SourceIntegrityError(
        // update keeps the pin of a version the lock already has, so only a new lock entry takes the new content
        `${name}: ${mismatches.join('; ')}, but ffmpeg.lock pins ${String(pin)}; if upstream really replaced it, delete ${name}'s entry in ffmpeg.lock and run ffmpeg-build lock to pin the new content`,
      );
    }
    throw new Error(`could not download from any of: ${source.archives.join(' ')}`);
  }
  const attempts = source.mirror ? GIT_ATTEMPTS_BEFORE_MIRROR : GIT_ATTEMPTS;
  let origin = source.git;
  try {
    await retry(attempts, async () => clone(source.git, source, dest));
  } catch (error) {
    if (!source.mirror) {
      throw error;
    }
    process.stderr.write(`  ${source.git} unavailable; using the mirror ${source.mirror}\n`);
    await retry(GIT_ATTEMPTS, async () => clone(source.mirror!, source, dest));
    origin = source.mirror;
  }
  // the commit the lock pins (a branch library's version is one): a tag that moved upstream is not built
  const head = (await run('git', ['-C', dest, 'rev-parse', 'HEAD'], { capture: true })).trim();
  if (source.commit && head !== source.commit) {
    rmSync(dest, { recursive: true, force: true });
    throw new SourceIntegrityError(
      'ref' in source
        ? // update keeps the pin of a version the lock already has, so only a new lock entry takes the new commit
          `${name}: ref ${source.ref} of ${origin} is commit ${head}, but ffmpeg.lock pins ${source.commit}; if upstream moved it on purpose, delete ${name}'s entry in ffmpeg.lock and run ffmpeg-build lock to pin the new commit`
        : `${name}: ${origin} gave commit ${head}, not ${source.commit}`,
    );
  }
  // a network step like the clone, so retried the same way (six attempts, 4 s doubling)
  if (source.submodules) {
    await retry(GIT_ATTEMPTS, async () =>
      run('git', submoduleArgs(source.submodules!), { cwd: dest, ...gitNetwork() }),
    );
  }
  return { origin, kept: '', commit: head };
}

/** `git submodule update --init [--recursive] [--depth N] [paths...]`, as the recipe's `submodules:` asks. */
export function submoduleArgs(submodules: Submodules): string[] {
  return [
    'submodule',
    'update',
    '--init',
    ...(submodules.recursive ? ['--recursive'] : []),
    ...(submodules.depth ? ['--depth', String(submodules.depth)] : []),
    ...submodules.paths,
  ];
}

function nestedRepositories(root: string, dir = root): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter(
    (e) => e.name !== '.git' && e.isDirectory(),
  )) {
    const path = join(dir, entry.name);
    if (existsSync(join(path, '.git'))) {
      found.push(path);
    } else {
      found.push(...nestedRepositories(root, path));
    }
  }
  return found;
}

async function disableArchiveAttributes(repo: string): Promise<void> {
  const gitDir = (
    await run('git', ['-C', repo, 'rev-parse', '--absolute-git-dir'], { capture: true })
  ).trim();
  const attributes = join(gitDir, 'info', 'attributes');
  mkdirSync(dirname(attributes), { recursive: true });
  const line = '* -export-ignore -export-subst';
  if (!(readFileIfPresent(attributes) ?? '').split(/\r?\n/).includes(line)) {
    appendFileSync(attributes, `${line}\n`);
  }
}

/** Whether `path` is a readable .tar.gz whose every member is under `prefix`. */
async function isArchiveOf(path: string, prefix: string): Promise<boolean> {
  try {
    const members = await listTarGzMembers(path);
    return (
      members.length > 0 && members.every((m) => m.name === prefix || m.name.startsWith(prefix))
    );
  } catch {
    return false;
  }
}

export async function keepGitSource(
  src: string,
  name: string,
  sources: string,
  work: string,
): Promise<{ kept: string; commit: string }> {
  const commit = (await run('git', ['-C', src, 'rev-parse', 'HEAD'], { capture: true })).trim();
  const kept = `${name}/${name}-${commit}.tar.gz`;
  const final = join(sources, kept);
  // a kept archive of this commit is used again only when it reads as one: one that doesn't (cut short, overwritten)
  // is made again. The path comes from the checkout's own commit, never from a record.
  if (existsSync(final)) {
    if (await isArchiveOf(final, `${name}-${commit}/`)) {
      return { kept, commit };
    }
    rmSync(final, { force: true });
  }
  mkdirSync(dirname(final), { recursive: true });
  const tar = join(work, `keep-${process.pid}.tar`);
  const part = join(work, `keep-part-${process.pid}.tar`);
  const temp = `${final}.tmp.${process.pid}`;
  // every temporary file goes, whether archiving works or not
  try {
    await disableArchiveAttributes(src);
    await run('git', [
      '-C',
      src,
      'archive',
      '--format=tar',
      `--prefix=${name}-${commit}/`,
      `--output=${tar}`,
      'HEAD',
    ]);
    for (const repo of nestedRepositories(src).sort()) {
      await disableArchiveAttributes(repo);
      await run('git', [
        '-C',
        repo,
        'archive',
        '--format=tar',
        `--prefix=${name}-${commit}/${relative(src, repo).replaceAll('\\', '/')}/`,
        `--output=${part}`,
        'HEAD',
      ]);
      await run('tar', ['-Af', tar, part]);
      rmSync(part, { force: true });
    }
    await run('gzip', ['-n', tar]);
    // `work` and the persistent cache are separate Docker mounts. Copy into an
    // adjacent temporary file before the atomic hard-link, since rename cannot
    // cross filesystems (EXDEV).
    copyFileSync(`${tar}.gz`, temp);
    placeOnce(temp, final);
  } finally {
    for (const f of [tar, `${tar}.gz`, part, temp]) {
      rmSync(f, { force: true });
    }
  }
  return { kept, commit };
}

export function sourceRecord(
  name: string,
  version: string,
  fetched: FetchedSource,
  sources: string,
): SourceRecord {
  return {
    name,
    version,
    origin: fetched.origin,
    file: fetched.kept,
    sha256: sha256(join(sources, fetched.kept)),
    ...(fetched.commit ? { commit: fetched.commit } : {}),
  };
}
