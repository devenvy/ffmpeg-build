import { rmSync } from 'node:fs';

import { expect, it } from 'vitest';

import { makeGitRepo } from './upstream-helpers.ts';
import { loadEngineData, versionSource } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { findVersions } from '../src/upstream.ts';

it('discovers native sndio 1.10 updates without selecting releases that require the missing BSD dependency stack', async () => {
  const source = versionSource(loadEngineData(packageRoot), 'sndio');
  if (source.kind !== 'git-tags') {
    throw new Error('sndio discovery must retain releases removed from the homepage listing');
  }
  const repo = makeGitRepo(['v1.9.0', 'v1.10.0', 'v1.10.1', 'v1.11.0', 'v2.0.0']);
  try {
    expect(await findVersions({ ...source, repo: repo.url }, 'sndio', [0])).toEqual({
      versions: ['1.10.0', '1.10.1'],
    });
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});
