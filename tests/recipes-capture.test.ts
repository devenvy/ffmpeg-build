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
    put(header, '#ifdef LIBV4L_HAVE_POSIX_IOCTL\n');
    await build(h, 'v4l-utils');
    // on musl, the installed header declares the POSIX ioctl libv4l2 was built with
    expect(h.read(header)).toBe(
      platform.startsWith('linux-musl-')
        ? '#if 1 /* musl: built with POSIX ioctl */\n'
        : '#ifdef LIBV4L_HAVE_POSIX_IOCTL\n',
    );
    // argp is only the tools', libintl only libdvbv5's, and musl's C library has neither
    expect(h.read(meson)).toBe(
      "    dep_argp = cc.find_library('argp', required : false)\ndep_intl = dependency('intl', required : false)\n",
    );
    expect(commands(h)).toEqual(
      mesonLines(h, [
        '-Dauto_features=disabled',
        '-Dv4l-utils=false',
        '-Dv4l-plugins=false',
        '-Dv4l-wrappers=false',
        '-Ddoxygen-doc=disabled',
      ]),
    );
  });
});

describe('libraw1394', () => {
  it.each(platformsOf('libraw1394'))('%s', async (platform) => {
    const h = fake(platform);
    const header = join(h.src, 'src', 'raw1394.h');
    put(header, '#include <sys/types.h>\n\tu_int8_t tcode;\nu_int64_t mask; my_u_int8_t x;\n');
    await build(h, 'libraw1394');
    // stdint.h's types for the BSD ones musl leaves out under FFmpeg's feature macros
    expect(h.read(header)).toBe(
      '#include <sys/types.h>\n#include <stdint.h>\n\tuint8_t tcode;\nuint64_t mask; my_u_int8_t x;\n',
    );
    expect(commands(h)).toEqual([configureLine(h, STATIC), 'make -j4', 'make install']);
  });
});

describe.each(['libiec61883'])('%s', (name) => {
  it.each(platformsOf(name))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, name);
    expect(commands(h)).toEqual([configureLine(h, STATIC), 'make -j4', 'make install']);
  });
});

describe('libavc1394', () => {
  it.each(platformsOf('libavc1394'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libavc1394');
    // its two libraries and libavc1394.pc, not its test programs
    // its 2008 config.guess knows no 64-bit ARM: the build machine is named there
    const build64: Record<string, string[]> = {
      'linux-arm64': ['--build=aarch64-unknown-linux-gnu'],
      'linux-musl-arm64': ['--build=aarch64-unknown-linux-musl'],
    };
    expect(commands(h)).toEqual([
      configureLine(h, [...STATIC, ...(build64[platform] ?? [])]),
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
