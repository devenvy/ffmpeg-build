import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSpdx, type SpdxInput } from '../../src/sbom.ts';
import { JSON_INDENT } from '../../src/text.ts';

/** An inventory bound to fixture archive bytes, for publication/aggregation tests. */
export function fixtureSbom(
  dist: string,
  name: string,
  platform = 'linux-x64',
  extra: Partial<Pick<SpdxInput, 'packages' | 'relationships' | 'licenses'>> = {},
): string {
  const names = [`${name}.tar.gz`, `${name}-dev.tar.gz`].filter((file) =>
    existsSync(join(dist, file)),
  );
  const version = /^ffmpeg-(\d+\.\d+\.\d+)/.exec(name)?.[1] ?? 'test';
  const document = createSpdx({
    name,
    target: name,
    platform,
    engine: 'test',
    created: '2026-10-27T00:00:00Z',
    describes: names,
    packages: [
      ...names.map(
        (file) =>
          ({
            key: file,
            name: file,
            version,
            purpose: 'ARCHIVE',
            sha256: createHash('sha256')
              .update(readFileSync(join(dist, file)))
              .digest('hex'),
          }) as const,
      ),
      ...(extra.packages ?? []),
    ],
    relationships: extra.relationships ?? [],
    ...(extra.licenses ? { licenses: extra.licenses } : {}),
  });
  const filename = `${name}.spdx.json`;
  writeFileSync(join(dist, filename), `${JSON.stringify(document, null, JSON_INDENT)}\n`);
  return filename;
}
