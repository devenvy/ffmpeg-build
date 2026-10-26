import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { packageRoot } from '../src/paths.ts';

it.skipIf(process.platform !== 'linux')('refreshes only unmodified GNU auxiliary tools', () => {
  const result = spawnSync('python3', [join(packageRoot, 'tests/libbs2b-aux-tools.py')], {
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(result.status, result.stderr).toBe(0);
});
