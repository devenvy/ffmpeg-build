// Batch f of #21 (devices): the capture libraries (libv4l2, FireWire's libdc1394 and libiec61883), each library's build
// on every platform it builds on, with the process runner stubbed, and the files it leaves in deps.
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
const CAPTURE = ['v4l-utils', 'libraw1394', 'libavc1394', 'libiec61883', 'libdc1394'];

describe('the capture libraries', () => {
  it('build on Linux alone, under LGPL-2.1-or-later', () => {
    for (const name of CAPTURE) {
      expect(platformsOf(name), name).toEqual(LINUX);
      expect(recipe(name).license, name).toBe('LGPL-2.1-or-later');
    }
  });
  it('stack up on libraw1394', () => {
    expect(recipe('libavc1394').needs).toEqual([{ name: 'libraw1394' }]);
    expect(recipe('libiec61883').needs).toEqual([{ name: 'libraw1394' }, { name: 'libavc1394' }]);
    expect(recipe('libdc1394').needs).toEqual([{ name: 'libraw1394' }]);
  });
  it("gives FFmpeg's iec61883 link the libraries again, in the order a static link needs", () => {
    expect(recipe('libiec61883').configure).toEqual([
      { value: '--enable-libiec61883' },
      { value: '--extra-libs=-lavc1394 -lrom1394 -lraw1394' },
    ]);
  });
});

describe('v4l-utils', () => {
  it.each(platformsOf('v4l-utils'))('%s', async (platform) => {
    const h = fake(platform);
    const meson = join(h.src, 'meson.build');
    put(meson, "    dep_argp = cc.find_library('argp')\ndep_intl = dependency('intl')\n");
    const header = join(h.deps, 'include', 'libv4l2.h');
    h.onRun = (call) => {
      if (call.command === 'meson' && call.args[0] === 'install') {
        put(
          join(h.src, '_stage', 'usr', 'include', 'libv4l2.h'),
          '#ifdef LIBV4L_HAVE_POSIX_IOCTL\n',
        );
        put(
          join(h.src, '_stage', 'usr', 'lib', 'pkgconfig', 'libv4l2.pc'),
          'prefix=/usr\nCflags: -I/include\n',
        );
      }
      return undefined;
    };
    await build(h, 'v4l-utils');
    // on musl, the installed header declares the POSIX ioctl libv4l2 was built with
    expect(h.read(header)).toBe('#ifdef LIBV4L_HAVE_POSIX_IOCTL\n');
    expect(h.read(pcPath(h, 'libv4l2'))).toBe(
      platform.startsWith('linux-musl-')
        ? `prefix=${h.deps}\nCflags: -I/include -DLIBV4L_HAVE_POSIX_IOCTL\n`
        : `prefix=${h.deps}\nCflags: -I/include\n`,
    );
    // Supply native configure prerequisites without rewriting upstream's checks.
    expect(h.read(meson)).toBe(
      "    dep_argp = cc.find_library('argp')\ndep_intl = dependency('intl')\n",
    );
    expect(commands(h)).toEqual(
      [
        ...mesonLines(h, [
          '--prefix=/usr',
          '-Dauto_features=disabled',
          '-Dv4l-utils=false',
          '-Dv4l-plugins=false',
          '-Dv4l-wrappers=false',
          '-Ddoxygen-doc=disabled',
        ]),
        ...(platform === 'linux-x64'
          ? [
              `python3 -c import os, runpy; runpy.run_path(os.path.join(os.environ['RECIPES'], 'v4l-utils', 'check-public-api.py'), run_name='__main__') ${h.deps} gcc `,
            ]
          : []),
      ].map((line) => `${line} [DESTDIR=${h.src}/_stage]`),
    );
  });
});

describe('libraw1394', () => {
  it.each(platformsOf('libraw1394'))('%s', async (platform) => {
    const h = fake(platform);
    const header = join(h.src, 'src', 'raw1394.h');
    put(header, '#include <sys/types.h>\n\tu_int8_t tcode;\nu_int64_t mask; my_u_int8_t x;\n');
    put(pcPath(h, 'libraw1394'), 'Cflags: -I/include\n');
    await build(h, 'libraw1394');
    // Select musl's documented feature profile; leave the native public types untouched.
    expect(h.read(header)).toBe(
      '#include <sys/types.h>\n\tu_int8_t tcode;\nu_int64_t mask; my_u_int8_t x;\n',
    );
    const featureFlags = platform.startsWith('linux-musl-')
      ? ` [CPPFLAGS=${h.context.env['CPPFLAGS'] ?? ''} -D_DEFAULT_SOURCE]`
      : '';
    expect(commands(h)).toEqual(
      [configureLine(h, STATIC), 'make -j4', 'make install'].map((line) => line + featureFlags),
    );
    expect(h.read(pcPath(h, 'libraw1394'))).toBe(
      platform.startsWith('linux-musl-')
        ? 'Cflags: -I/include -D_DEFAULT_SOURCE\n'
        : 'Cflags: -I/include\n',
    );
  });
});

// autoreconf first: their config.guess and config.sub know neither 64-bit ARM nor musl
describe('libiec61883', () => {
  it.each(platformsOf('libiec61883'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libiec61883');
    expect(commands(h)).toEqual([
      'autoreconf -fi',
      configureLine(h, STATIC),
      'make -j4',
      'make install',
    ]);
  });
});

describe('libavc1394', () => {
  it.each(platformsOf('libavc1394'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libavc1394');
    // its two libraries and libavc1394.pc, not its test programs
    expect(commands(h)).toEqual([
      'autoreconf -fi',
      configureLine(h, STATIC),
      'make -j4 -C common',
      'make -C libavc1394 install',
      'make -C librom1394 install',
      'make install-pkgconfigDATA',
    ]);
  });
});

describe('libdc1394', () => {
  it.each(platformsOf('libdc1394'))('%s', async (platform) => {
    const h = fake(platform);
    const pc = pcPath(h, 'libdc1394-2');
    h.onRun = (call) => {
      if (call.args.includes('install')) {
        put(pc, 'Name: libdc1394\nLibs: -ldc1394\n');
      }
      return undefined;
    };
    await build(h, 'libdc1394');
    const env = ` [CPPFLAGS= -I${h.deps}/include LDFLAGS= -L${h.deps}/lib]`;
    expect(commands(h)).toEqual([
      configureLine(h, [...STATIC, '--disable-examples', '--disable-sdltest'], env),
      `make -j4${env}`,
      `make install${env}`,
    ]);
    // a static link takes libraw1394 and libm, which its .pc doesn't name
    expect(h.read(pc)).toContain('Requires.private: libraw1394');
    expect(h.read(pc)).toContain('Libs.private: -lm');
  });
});
