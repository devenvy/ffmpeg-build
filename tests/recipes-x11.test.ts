// Batch f of #21 (devices): the X11 libraries (xcb, xlib) and libcaca's, each library's build on every platform it
// builds on, with the process runner stubbed, and the files it leaves in deps.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  build,
  commands,
  configureLine,
  type Harness,
  harness,
  mesonLines,
  pcPath,
  platformsOf,
  recipe,
} from './recipe-harness.ts';
import { PLATFORMS } from '../src/platforms.ts';

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
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const LINUX = PLATFORMS.filter((p) => p.startsWith('linux-'));
const STATIC = ['--disable-shared', '--enable-static', '--with-pic'];
const X11 = [
  'xorgproto',
  'xcb-proto',
  'libxau',
  'libxcb',
  'xtrans',
  'libx11',
  'libxext',
  'libxv',
  'ncurses',
  'libcaca',
];

describe('the X11 and terminal libraries', () => {
  it('build on Linux alone', () => {
    for (const name of X11) {
      expect(platformsOf(name), name).toEqual(LINUX);
    }
  });
  it('are under permissive licences, which every build may take', () => {
    expect(recipe('libxcb').license).toBe('X11');
    expect(recipe('libx11').license).toBe('MIT AND X11');
    expect(recipe('libxv').license).toBe('SMLNJ AND HPND-sell-variant');
    expect(recipe('libcaca').license).toBe('WTFPL');
    expect(recipe('ncurses').license).toBe('MIT-open-group');
  });
  it('stack up: xcb on xcb-proto and libXau, Xlib on xcb, libXv on libXext, libcaca on ncurses', () => {
    expect(recipe('libxcb').needs).toEqual([{ name: 'xcb-proto' }, { name: 'libxau' }]);
    expect(recipe('libx11').needs).toEqual([
      { name: 'xorgproto' },
      { name: 'xtrans' },
      { name: 'libxcb' },
    ]);
    expect(recipe('libxext').needs).toEqual([{ name: 'libx11' }]);
    expect(recipe('libxv').needs).toEqual([{ name: 'libxext' }]);
    expect(recipe('libcaca').needs).toEqual([{ name: 'ncurses' }]);
  });
});

describe('xorgproto', () => {
  it.each(platformsOf('xorgproto'))('%s', async (platform) => {
    const h = fake(platform);
    h.onRun = (call) => {
      if (call.command === 'meson' && call.args[0] === 'install') {
        put(join(h.deps, 'share', 'pkgconfig', 'xproto.pc'), 'Name: Xproto\n');
      }
      return undefined;
    };
    await build(h, 'xorgproto');
    expect(commands(h)).toEqual(mesonLines(h, []));
    // its .pc files where the build's pkg-config looks
    expect(h.read(pcPath(h, 'xproto'))).toBe('Name: Xproto\n');
  });
});

describe.each(['xcb-proto', 'xtrans'])('%s', (name) => {
  it.each(platformsOf(name))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, name);
    expect(commands(h)).toEqual([
      configureLine(h, []),
      'make -j4',
      `make install pkgconfigdir=${h.deps}/lib/pkgconfig`,
    ]);
  });
});

describe.each([
  ['libxau', STATIC],
  ['libxcb', [...STATIC, '--disable-devel-docs', '--without-doxygen']],
  ['libxext', [...STATIC, '--disable-specs', '--without-xmlto', '--without-fop']],
  ['libxv', STATIC],
])('%s', (name, args) => {
  it.each(platformsOf(name))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, name);
    expect(commands(h)).toEqual([configureLine(h, args), 'make -j4', 'make install']);
  });
});

describe('libx11', () => {
  it.each(platformsOf('libx11'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libx11');
    // the system's X11 data (/usr/share/X11) compiled in; the libraries, headers and .pc files installed
    expect(commands(h)).toEqual([
      configureLine(h, [
        ...STATIC,
        '--datadir=/usr/share',
        '--disable-loadable-i18n',
        '--disable-specs',
        '--without-xmlto',
        '--without-fop',
        '--without-xsltproc',
        '--without-lint',
        `--with-keysymdefdir=${h.deps}/include/X11`,
      ]),
      'make -j4',
      'make -C src install',
      'make -C include install',
      'make install-pkgconfigDATA',
    ]);
  });
});

describe('ncurses', () => {
  it.each(platformsOf('ncurses'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'ncurses');
    expect(commands(h)).toEqual([
      configureLine(h, [
        '--without-shared',
        '--with-normal',
        '--with-pic',
        '--enable-widec',
        '--without-debug',
        '--without-ada',
        '--without-cxx',
        '--without-cxx-binding',
        '--without-progs',
        '--without-tests',
        '--without-manpages',
        '--disable-db-install',
        '--enable-pc-files',
        `--with-pkg-config-libdir=${h.deps}/lib/pkgconfig`,
        '--with-terminfo-dirs=/etc/terminfo:/lib/terminfo:/usr/share/terminfo:/usr/lib/terminfo',
        '--with-default-terminfo-dir=/usr/share/terminfo',
      ]),
      'make -j4',
      'make install',
    ]);
  });
});

describe('libcaca', () => {
  it.each(platformsOf('libcaca'))('%s', async (platform) => {
    const h = fake(platform);
    const pc = pcPath(h, 'caca');
    h.onRun = (call) => {
      if (call.args.includes('install')) {
        put(pc, 'Name: caca\nLibs: -lcaca\nLibs.private: \n');
      }
      return undefined;
    };
    await build(h, 'libcaca');
    const env = ` [CPPFLAGS= -I${h.deps}/include LDFLAGS= -L${h.deps}/lib]`;
    expect(commands(h)).toEqual([
      configureLine(
        h,
        [
          ...STATIC,
          '--enable-ncurses',
          '--disable-slang',
          '--disable-x11',
          '--disable-gl',
          '--disable-cocoa',
          '--disable-network',
          '--disable-vga',
          '--disable-kernel',
          '--disable-win32',
          '--disable-conio',
          '--disable-csharp',
          '--disable-java',
          '--disable-cxx',
          '--disable-python',
          '--disable-ruby',
          '--disable-imlib2',
          '--disable-doc',
          '--disable-cppunit',
          '--disable-zzuf',
        ],
        env,
      ),
      `make -j4 -C caca${env}`,
      `make -C caca install${env}`,
    ]);
    // a static link takes ncurses (and libm), which its caca.pc doesn't name
    expect(h.read(pc)).toContain('Requires.private: ncursesw');
    expect(h.read(pc)).toContain('-lm');
  });
});
