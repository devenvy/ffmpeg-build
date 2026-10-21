import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { build, type Harness, harness, pcPath, platformsOf } from './recipe-harness.ts';

import type * as RunModule from '../src/build/run.ts';

vi.mock('../src/build/run.ts', async (original) => ({
  ...(await original<typeof RunModule>()),
  run: vi.fn(),
}));

const made: Harness[] = [];
afterEach(() => {
  for (const h of made.splice(0)) {
    rmSync(h.root, { recursive: true, force: true });
  }
});

describe('static nonfree audio linkage', () => {
  it.each(platformsOf('fdk-aac'))(
    'declares libm on %s even when CMake found sin in libc',
    async (platform) => {
      const h = harness(platform);
      made.push(h);
      for (const file of [
        '_build/libfdk-aac.a',
        '_build/fdk-aac.pc',
        'cpp/libSYS/include/machine_type.h',
        'cpp/libSYS/include/genericStds.h',
        'cpp/libSYS/include/FDK_audio.h',
        'cpp/libSYS/include/syslib_channelMapDescr.h',
        'cpp/libAACenc/include/aacenc_lib.h',
        'cpp/libAACdec/include/aacdecoder_lib.h',
      ]) {
        const path = join(h.src, file);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, file.endsWith('.pc') ? 'Name: fdk-aac\nLibs: -lfdk-aac\n' : '');
      }
      await build(h, 'fdk-aac');
      expect(h.read(pcPath(h, 'fdk-aac'))).toContain('Libs.private: -lm');
    },
  );
});
