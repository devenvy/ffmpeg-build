import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { harness, type Harness, pcPath, recipe } from './recipe-harness.ts';
import { runRecipe } from '../src/build/library.ts';
import { linkedRecipe } from '../src/linkage.ts';

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

describe('OpenVINO native SDK metadata', () => {
  it.each(['static', 'shared'] as const)(
    'preserves upstream interface flags and native archives in %s mode',
    async (mode) => {
      const h = harness('linux-x64');
      made.push(h);
      const definitions = mode === 'static' ? ' -DOPENVINO_STATIC_LIBRARY' : '';
      const cflags = `Cflags: -I\${includedir}${definitions} -D_GLIBCXX_USE_CXX11_ABI=1\n`;
      h.write(
        pcPath(h, 'openvino'),
        `prefix=${h.deps}\nLibs: -L\${libdir} -lopenvino_c -lopenvino\nLibs.private: -ldl -lm -lpthread -lrt\n${cflags}`,
      );
      h.write(join(h.deps, 'lib', 'libopenvino.a'), '!<arch>\nnative core archive\n');
      await runRecipe(
        h.context,
        {
          name: 'openvino',
          version: '2026.4.1',
          build: linkedRecipe(recipe('openvino'), mode).build,
        },
        h.src,
      );
      const metadata = h.read(pcPath(h, 'openvino'));
      expect(metadata).toContain(cflags);
      expect(metadata).toContain('Libs.private: -ldl -lm -lpthread -lrt\n');
      expect(metadata).toContain(
        `Libs: -L\${libdir} ${mode === 'static' ? '-l:ffb-openvino-cpu.ld' : '-lopenvino_c -lopenvino'}\n`,
      );
      expect(h.read(join(h.deps, 'lib', 'libopenvino.a'))).toBe('!<arch>\nnative core archive\n');
    },
  );
});
