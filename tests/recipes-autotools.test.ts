// The standard autotools build against what each library's old build.sh (b11ed92) ran: the prefix first, the
// library's own arguments, `--host=<triple>` last and only when cross-compiling. Nothing else is a default: the
// scripts differed in --libdir, --with-pic and their order.
import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { build, commands, type Harness, harness, platformsOf } from './recipe-harness.ts';
import { runRecipe } from '../src/build/library.ts';
import { recipeSchema } from '../src/schema/engine.ts';

import type * as RunModule from '../src/build/run.ts';

vi.mock('../src/build/run.ts', async (original) => ({
  ...(await original<typeof RunModule>()),
  run: vi.fn(),
}));

let made: Harness[] = [];
afterEach(() => {
  for (const h of made) {
    rmSync(h.root, { recursive: true, force: true });
  }
  made = [];
});
function fake(platform: string): Harness {
  const h = harness(platform);
  made.push(h);
  return h;
}

describe('the standard autotools configure line', () => {
  it('is ./configure --prefix=<deps> <args> [--host=<host>]', async () => {
    for (const platform of ['linux-x64', 'win-arm64']) {
      const h = fake(platform);
      const parsed = recipeSchema.parse({
        name: 'sample',
        license: 'MIT',
        'license-files': ['COPYING'],
        source: { git: 'g' },
        versions: { 'git-tags': '^(.*)$' },
        platforms: 'all',
        build: { system: 'autotools', args: ['--a', '--b={deps}'] },
      });
      await runRecipe(h.context, { version: '1.2.3', build: parsed.build }, h.src);
      const host = platform === 'win-arm64' ? ' --host=aarch64-w64-mingw32' : '';
      expect(commands(h)).toEqual([
        `./configure --prefix=${h.deps} --a --b=${h.deps}${host}`,
        'make -j4',
        'make install',
      ]);
    }
  });
});

// The ARGS array of each old build.sh, before its `[ -n "${CROSS_HOST:-}" ] && ARGS+=(--host="${CROSS_HOST}")`.
const OLD: Record<string, (deps: string) => string[]> = {
  gmp: (d) => [
    `--libdir=${d}/lib`,
    '--disable-shared',
    '--enable-static',
    '--with-pic',
    '--enable-cxx=no',
  ],
  kvazaar: (d) => [`--libdir=${d}/lib`, '--disable-shared', '--enable-static', '--with-pic'],
  libmp3lame: () => [
    '--disable-shared',
    '--enable-static',
    '--disable-frontend',
    '--disable-decoder',
    '--enable-nasm',
    '--with-pic',
  ],
  libogg: () => ['--disable-shared', '--enable-static', '--with-pic'],
  libtasn1: (d) => [
    `--libdir=${d}/lib`,
    '--disable-shared',
    '--enable-static',
    '--with-pic',
    '--disable-doc',
  ],
  libvorbis: (d) => ['--disable-shared', '--enable-static', `--with-ogg=${d}`, '--with-pic'],
  nettle: (d) => [
    `--libdir=${d}/lib`,
    '--disable-shared',
    '--enable-static',
    '--disable-documentation',
  ],
  'opencore-amr': () => ['--disable-shared', '--enable-static', '--with-pic'],
  speex: () => ['--disable-shared', '--enable-static', '--with-pic', '--disable-binaries'],
  'vo-amrwbenc': () => ['--disable-shared', '--enable-static', '--with-pic'],
};

describe.each(Object.keys(OLD))('%s configures as its build.sh did', (name) => {
  it.each(platformsOf(name))('%s', async (platform) => {
    const h = fake(platform);
    h.onRun = (call) => {
      if (call.command === './configure') {
        throw new Error('stop');
      }
    }; // only the configure line
    await expect(build(h, name)).rejects.toThrow('stop');
    const configure = h.calls.find((c) => c.command === './configure')!;
    const host = h.context.env['CROSS_HOST'];
    expect(configure.args).toEqual([
      `--prefix=${h.deps}`,
      ...OLD[name]!(h.deps),
      ...(host ? [`--host=${host}`] : []),
    ]);
  });
});

describe('gmp and nettle flags without a toolchain value', () => {
  // CFLAGS="${CFLAGS:-} -std=gnu17": an unset CFLAGS (Android, Windows) gives " -std=gnu17", never a placeholder
  it.each(['android-arm64', 'linux-x64'])('%s', async (platform) => {
    const h = fake(platform);
    h.onRun = (call) => {
      if (call.command === './configure') {
        throw new Error('stop');
      }
    };
    await expect(build(h, 'nettle')).rejects.toThrow('stop');
    const env = h.calls[0]!.env;
    expect(env['CFLAGS']).toBe(`${h.context.env['CFLAGS'] ?? ''} -std=gnu17`);
    expect(env['LDFLAGS']).toBe(`-L${h.deps}/lib ${h.context.env['LDFLAGS'] ?? ''}`);
    expect(env['CPPFLAGS']).toBe(`-I${h.deps}/include `);
  });
});
