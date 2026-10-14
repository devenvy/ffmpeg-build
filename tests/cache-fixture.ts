// A library cache as builds leave it, for the tests of `ffmpeg-build cache` and of src/cache-admin.ts.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tarGz } from './github-fake.ts';

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** A day, in milliseconds. */
export const DAY = 86_400_000;
const MS_PER_S = 1000;
/** The size of the library each entry holds. */
const LIBRARY_BYTES = 1000;

/** Sets a file's times to `days` ago. */
export function age(path: string, days: number): void {
  const t = (Date.now() - days * DAY) / MS_PER_S;
  utimesSync(path, t, t);
}

/** A cache with library entries (each with its source record and kept source), as builds leave it. */
export function libraryCache(
  entries: {
    key: string;
    name: string;
    version: string;
    source?: string;
    record?: boolean;
    ageDays?: number;
    sourceSha?: string;
  }[],
): string {
  const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-cachecmd-'));
  mkdirSync(join(root, 'libs'), { recursive: true });
  for (const e of entries) {
    const file = `${e.name}/${e.name}-${e.version}.tar.xz`;
    const source = e.source ?? `source of ${e.name}`;
    const record = {
      name: e.name,
      version: e.version,
      origin: `https://example.com/${file}`,
      file,
      sha256: e.sourceSha ?? sha(source),
    };
    const members = [
      { name: 'lib/libx.a', data: 'x'.repeat(LIBRARY_BYTES) },
      ...(e.record === false
        ? []
        : [
            {
              name: `share/ffmpeg-build/sources/${e.name}.json`,
              data: `${JSON.stringify(record)}\n`,
            },
          ]),
    ];
    const entry = join(root, 'libs', `${e.key}.tar.gz`);
    writeFileSync(entry, tarGz(members));
    mkdirSync(join(root, 'sources', e.name), { recursive: true });
    writeFileSync(join(root, 'sources', file), source);
    if (e.ageDays) {
      age(entry, e.ageDays);
      age(join(root, 'sources', file), e.ageDays);
    }
  }
  return root;
}
