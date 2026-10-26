import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { harness, type Harness, recipe } from './recipe-harness.ts';
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

describe('Fontconfig native dependency discovery', () => {
  it.each(['static', 'shared'] as const)(
    'keeps %s artifact selection with complete dependency metadata',
    async (mode) => {
      const h = harness('linux-x64');
      made.push(h);
      h.write(join(h.src, 'meson.build'), 'native project input\n');
      h.onRun = (call) => {
        if (call.command === 'meson' && call.args[0] === 'install') {
          h.write(
            join(call.env['DESTDIR']!, 'usr', 'lib', 'pkgconfig', 'fontconfig.pc'),
            'prefix=/usr\nlibdir=/usr/lib\nincludedir=/usr/include\nLibs: -lfontconfig\n',
          );
        }
      };
      await runRecipe(
        h.context,
        {
          name: 'fontconfig',
          version: '2.15.0',
          build: linkedRecipe(recipe('fontconfig'), mode).build,
        },
        h.src,
      );
      const file = join(h.src, 'ffb-fontconfig-pkg-config.ini');
      expect(existsSync(file)).toBe(false);
      expect(h.calls[0]!.args).toContain(`--default-library=${mode}`);
      expect(h.read(join(h.src, 'meson.build'))).toBe('native project input\n');
    },
  );

  it('links the native math dependency without replacing package discovery', async () => {
    const h = harness('linux-x64');
    made.push(h);
    h.onRun = (call) => {
      if (call.command === 'meson' && call.args[0] === 'install') {
        h.write(
          join(call.env['DESTDIR']!, 'usr', 'lib', 'pkgconfig', 'fontconfig.pc'),
          'prefix=/usr\nlibdir=/usr/lib\nincludedir=/usr/include\nLibs: -lfontconfig\n',
        );
      }
    };
    await runRecipe(
      h.context,
      {
        name: 'fontconfig',
        version: '2.15.0',
        build: linkedRecipe(recipe('fontconfig'), 'shared').build,
      },
      h.src,
    );
    expect(h.calls[0]!.args).toEqual(
      expect.arrayContaining([
        '-Dc_link_args=-Wl,--push-state,--no-as-needed,-lm,--pop-state',
        '--wrap-mode=nofallback',
      ]),
    );
  });
});
