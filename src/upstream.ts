import { execFile } from 'node:child_process';

import { GitMissingError } from './git-missing-error.ts';
import { HttpError, retryableStatus, withNetRetry } from './net.ts';
import { compareVersions, isVersion } from './versions.ts';

import type { VersionSource } from './engine-data.ts';

export { GitMissingError };

const KIB = 1024;
const MIB = KIB * KIB;
/** The most git output (a big repository's tag list) read before giving up. */
const MAX_GIT_OUTPUT_MIB = 64;
/** The largest release listing page read. */
const MAX_PAGE_MIB = 5;
/** withRetry's default waits before its second and third attempts. */
const RETRY_DELAY_FIRST_MS = 250;
const RETRY_DELAY_SECOND_MS = 1000;
/** Up to this share of each retry wait is taken off at random, so retries don't line up. */
const RETRY_JITTER = 0.25;

/** Callbacks for failures nothing can be done about. */
const ignore = (): void => undefined;

/**
 * execFile as a promise of its output. Like util.promisify's, it rejects with execFile's error carrying the output as
 * `stdout` and `stderr` (its `code` says ENOENT for a missing command).
 */
async function execFileAsync(
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const failure: Error = Object.assign(error, { stdout, stderr });
        reject(failure);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** What upstream offers: release versions (ascending), or a branch's head commit. */
export type Found = { versions: string[] } | { commit: string };

/** An upstream that can't be read, or that has no matching versions. The message names what and where. */
export class UpstreamError extends Error {}

async function git(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      timeout: 120_000,
      maxBuffer: MAX_GIT_OUTPUT_MIB * MIB,
      // never stop to ask for a password; give up on a connection slower than 1 KB/s for a minute
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_HTTP_LOW_SPEED_LIMIT: '1000',
        GIT_HTTP_LOW_SPEED_TIME: '60',
      },
    });
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === 'ENOENT') {
      throw new GitMissingError();
    }
    const lines = (err.stderr ?? err.message).trim().split('\n');
    throw new Error(lines.find((l) => l.startsWith('fatal:')) ?? lines.at(-1) ?? 'git failed', {
      cause: e,
    });
  }
}

export async function gitTags(repo: string): Promise<string[]> {
  const out = await git(['ls-remote', '--tags', '--refs', '--', repo]); // --refs: no ^{} lines; --: a URL is never an option
  return out.split('\n').flatMap((line) => {
    const ref = line.split('\t')[1]?.trim();
    return ref?.startsWith('refs/tags/') ? [ref.slice('refs/tags/'.length)] : [];
  });
}

export async function gitBranchHead(repo: string, branch: string): Promise<string> {
  const commit = (await git(['ls-remote', '--heads', '--', repo, `refs/heads/${branch}`]))
    .split('\t')[0]
    ?.trim();
  if (!commit) {
    throw new Error(`no branch ${branch}`);
  }
  return commit;
}

/**
 * The commit a tag (or else a branch) named `ref` points at: an annotated tag's target, not the tag object. Asks only
 * for those refs, so a big repository costs one short answer.
 */
export async function gitRefCommit(repo: string, ref: string): Promise<string> {
  const out = await git([
    'ls-remote',
    '--',
    repo,
    `refs/tags/${ref}`,
    `refs/tags/${ref}^{}`,
    `refs/heads/${ref}`,
  ]);
  const refs = new Map(
    out.split('\n').flatMap((line) => {
      const [commit, name] = line.trim().split('\t');
      return commit && name ? [[name, commit]] : [];
    }),
  );
  const commit =
    refs.get(`refs/tags/${ref}^{}`) ??
    refs.get(`refs/tags/${ref}`) ??
    refs.get(`refs/heads/${ref}`);
  if (!commit) {
    throw new Error(`no tag or branch ${ref}`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`${ref} is ${commit}, not a full commit hash`);
  }
  return commit;
}

const MAX_PAGE = MAX_PAGE_MIB * MIB;

/** The last path part of every link on a page: `gmp-6.3.0.tar.xz`, or `4.0` for `/files/lame/4.0/`. */
export async function listingLinks(url: string): Promise<string[]> {
  // one attempt with a deadline: findVersions retries it (withRetry), and only what is worth retrying
  const html = await withNetRetry(
    async (signal) => {
      const res = await fetch(url, { signal });
      if (!res.ok) {
        await res.body?.cancel().catch(ignore);
        throw new HttpError(res.status, `HTTP ${res.status}`);
      }
      return res.text();
    },
    { attempts: 1 },
  );
  if (html.length > MAX_PAGE) {
    throw new Error('page is larger than 5 MB; is this really a release listing?');
  }
  return [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => lastSegment(m[1]!));
}

function lastSegment(href: string): string {
  const path = href.split(/[?#]/)[0]!.replace(/\/+$/, '');
  const segment = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Group 1 of `pattern` for every name, keeping only numbers; unique, oldest first. Numbers separated by `_` or `-`
 * (expat's R_2_8_3, freetype's VER-2-14-3) are read as dotted; a recipe's ref rebuilds them with {version_}/{version-}.
 */
function versionsFrom(names: readonly string[], pattern: RegExp): string[] {
  const found = new Set<string>();
  for (const name of names) {
    const raw = pattern.exec(name)?.[1];
    // only a version without dots uses _ or - as its separator; in 1.2.3-1 the dash is a suffix, not a part
    const v = raw && !raw.includes('.') ? raw.replace(/[_-]/g, '.') : raw;
    if (v && isVersion(v)) {
      found.add(v);
    }
  }
  return [...found].sort(compareVersions);
}

/**
 * Runs `fn`, retrying after each of `delays` (less up to a quarter, at random). Not retried: git missing, and an HTTP
 * answer that won't change (a 4xx other than 408/429).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  delays: number[] = [RETRY_DELAY_FIRST_MS, RETRY_DELAY_SECOND_MS],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (
        e instanceof GitMissingError ||
        (e instanceof HttpError && !retryableStatus(e.status)) ||
        (e as { permanent?: boolean } | undefined)?.permanent === true ||
        attempt >= delays.length
      ) {
        throw e;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, delays[attempt]! * (1 - RETRY_JITTER + Math.random() * RETRY_JITTER));
      });
    }
  }
}

/** What upstream offers for one source. `what` names it in errors (a recipe, or "FFmpeg"). */
export async function findVersions(
  source: VersionSource,
  what: string,
  delays?: number[],
): Promise<Found> {
  const where = source.kind === 'listing' ? source.url : source.repo;
  try {
    if (source.kind === 'git-branch') {
      return {
        commit: await withRetry(async () => gitBranchHead(source.repo, source.branch), delays),
      };
    }
    const names = await withRetry(
      async () => (source.kind === 'git-tags' ? gitTags(source.repo) : listingLinks(source.url)),
      delays,
    );
    const versions = versionsFrom(names, source.pattern);
    if (!versions.length) {
      throw new UpstreamError(
        `${what}: no versions found at ${where} matching ${source.pattern.source}`,
      );
    }
    return { versions };
  } catch (e) {
    if (e instanceof GitMissingError || e instanceof UpstreamError) {
      throw e;
    }
    throw new UpstreamError(`${what}: couldn't read ${where}: ${(e as Error).message}`);
  }
}

/** Run `fn` over `items`, at most `limit` at a time; results in input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]!) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
