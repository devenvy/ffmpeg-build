import { swapFiles, WriteError } from '../atomic-write.ts';
import { type EngineData, ffmpegVersionSource, versionSource } from '../engine-data.ts';
import { isCommit, SHORT_COMMIT_LENGTH } from '../ranges.ts';
import { findVersions, GitMissingError, mapLimit, UpstreamError } from '../upstream.ts';

import type { Upstreams } from '../choose.ts';

/** How many upstreams are asked at once. */
const UPSTREAM_CONCURRENCY = 8;

export class UpstreamFailure extends Error {
  readonly failures: string[];

  constructor(failures: string[]) {
    const ffmpegDown = failures.some((f) => f.startsWith('FFmpeg:'));
    super(
      `Couldn't read every upstream, so nothing was written:\n${failures.map((f) => `  ${f}`).join('\n')}${
        ffmpegDown
          ? "\nThe libraries weren't checked, because which builds need them depends on the FFmpeg version."
          : ''
      }`,
    );
    this.failures = failures;
  }
}

export { WriteError };

export type Fetch = (keys: readonly string[], into: Upstreams) => Promise<void>;

/** Fills `into` with what upstream offers for `keys` ('ffmpeg' or recipe names), 8 at a time. */
export function upstreamFetcher(data: EngineData): Fetch {
  const failed = new Map<string, string>(); // asked once per run: a second profile gets the same answer, not another wait
  return async (keys, into) => {
    const known = keys.filter((k) => failed.has(k)).map((k) => failed.get(k)!);
    const todo = keys.filter(
      (k) => !failed.has(k) && (k === 'ffmpeg' ? !into.ffmpeg : !into.libraries.has(k)),
    );
    const results = await mapLimit(todo, UPSTREAM_CONCURRENCY, async (k) =>
      k === 'ffmpeg'
        ? findVersions(ffmpegVersionSource(data), 'FFmpeg')
        : findVersions(versionSource(data, k), k),
    );
    const failures: string[] = [...known];
    results.forEach((result, i) => {
      const key = todo[i]!;
      if (result.status === 'rejected') {
        if (result.reason instanceof GitMissingError) {
          throw result.reason;
        }
        const message =
          result.reason instanceof UpstreamError
            ? result.reason.message
            : `${key}: ${String(result.reason)}`;
        failed.set(key, message);
        failures.push(message);
      } else if (key === 'ffmpeg') {
        into.ffmpeg = 'versions' in result.value ? result.value.versions : [];
      } else {
        into.libraries.set(key, result.value);
      }
    });
    if (failures.length) {
      throw new UpstreamFailure(failures);
    }
  };
}

export const shortVersion = (v: string): string =>
  isCommit(v) ? v.slice(0, SHORT_COMMIT_LENGTH) : v;

/**
 * Writes every file or none (atomic-write.ts): each staged in a temporary file of its own and flushed, then swapped in
 * with a backup, and put back if a later one fails. WriteError says whether everything was put back.
 */
export function stageAndSwap(writes: { path: string; text: string }[]): void {
  if (writes.length) {
    swapFiles(writes);
  }
}
