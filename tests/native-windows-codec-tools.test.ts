import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { harness, type Harness, recipe } from './recipe-harness.ts';
import { runRecipe } from '../src/build/library.ts';

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

describe('native Windows codec tool discovery', () => {
  it.each(['x264', 'libvpx'])(
    '%s uses the native MSYS2 tools without a cross prefix',
    async (name) => {
      const h = harness('win-x64');
      made.push(h);
      h.context.env['MSYSTEM'] = 'UCRT64';
      delete h.context.env['CROSS_PREFIX'];
      delete h.context.env['CROSS_HOST'];
      h.write(join(h.deps, 'lib/pkgconfig/vpx.pc'), 'prefix=/opt/ffmpeg-build/deps\n');
      await runRecipe(h.context, { name, version: '1.0', build: recipe(name).build }, h.src);
      expect(h.calls[0]!.args.join(' ')).not.toContain('--cross-prefix=');
      expect(h.calls.map((call) => call.env['CROSS'] ?? '')).toEqual(['', '', '']);
    },
  );
});
