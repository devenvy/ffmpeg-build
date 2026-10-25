import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { packageRoot } from '../src/paths.ts';

it.skipIf(process.platform !== 'linux')(
  'preserves native TensorFlow archive bytes and registration scope',
  () => {
    const result = spawnSync('python3', [join(packageRoot, 'tests/tensorflow-native-inputs.py')], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30000,
    });
    expect(result.status, result.stderr).toBe(0);
  },
);
