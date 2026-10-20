// Batch d of #21 (filters and processing): each library's build on every platform it builds on, with the process
// runner stubbed, and the files it leaves in deps.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  build,
  cmakeLines,
  commands,
  configureLine,
  type Harness,
  harness,
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
const env = (h: Harness, name: string) => h.context.env[name] ?? '';
/** What `CFLAGS: '+= -O2'` makes of the platform's CFLAGS, as `commands` shows it. */
const o2 = (h: Harness) => ` [CFLAGS=${env(h, 'CFLAGS')} -O2]`;

// vid.stab without OpenMP.
describe('vid.stab', () => {
  it.each(platformsOf('vid.stab'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'vid.stab');
    expect(commands(h)).toEqual(cmakeLines(h, ['-DUSE_OMP=OFF', '-DBUILD_SHARED_LIBS=OFF']));
  });
  it('is GPL-2.0-or-later (its last release), and builds everywhere', () => {
    expect(recipe('vid.stab').license).toBe('GPL-2.0-or-later');
    expect(platformsOf('vid.stab')).toEqual(PLATFORMS);
  });
});

// libmysofa's static library, position-independent, without its tests and sample files; zlib and libm in its .pc.
describe('libmysofa', () => {
  it.each(platformsOf('libmysofa'))('%s', async (platform) => {
    const h = fake(platform);
    put(
      join(h.src, 'src', 'CMakeLists.txt'),
      `PROPERTIES OUTPUT_NAME mysofa CLEAN_DIRECT_OUTPUT 1 POSITION_INDEPENDENT_CODE \${BUILD_SHARED_LIBS})\n`,
    );
    put(
      join(h.src, 'src', 'config.h.in'),
      `#define CMAKE_INSTALL_PREFIX "\${CMAKE_INSTALL_PREFIX}"\n#define CPACK_PACKAGE_VERSION_MAJOR 1\n`,
    );
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        put(
          pcPath(h, 'libmysofa'),
          `Libs: -L\${libdir} -lmysofa\nCflags: -I\${includedir}\n\nLibs.private: \n`,
        );
        put(join(h.deps, 'share', 'libmysofa', 'default.sofa'), 'sofa');
      }
      return undefined;
    };
    await build(h, 'libmysofa');
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DBUILD_TESTS=OFF',
        '-DBUILD_STATIC_LIBS=ON',
        '-DCODE_COVERAGE=OFF',
        '-DADDRESS_SANITIZE=OFF',
        '-DMATH=m',
      ]),
    );
    expect(h.read(join(h.src, 'src', 'CMakeLists.txt'))).toContain('POSITION_INDEPENDENT_CODE ON)');
    // no deps folder in the library: the default SOFA file is looked for where systems keep it
    expect(h.read(join(h.src, 'src', 'config.h.in'))).toBe(
      '#define CMAKE_INSTALL_PREFIX "/usr"\n#define CPACK_PACKAGE_VERSION_MAJOR 1\n',
    );
    expect(h.files(h.deps)).not.toContain('share/libmysofa/default.sofa');
    expect(h.read(pcPath(h, 'libmysofa'))).toBe(
      `Libs: -L\${libdir} -lmysofa\nCflags: -I\${includedir}\n\nLibs.private: -lz -lm\n`,
    );
  });
  it('needs zlib', () => {
    expect(recipe('libmysofa').needs).toEqual([{ name: 'zlib' }]);
  });
});

// libbs2b's library alone: configure.ac without its libsndfile check, remade, and only src's library and headers.
describe('libbs2b', () => {
  it.each(platformsOf('libbs2b'))('%s', async (platform) => {
    const h = fake(platform);
    put(
      join(h.src, 'configure.ac'),
      'AM_INIT_AUTOMAKE([1.10.1 -Wall foreign subdir-objects\n                  dist-zip dist-bzip2 dist-lzma])\n' +
        '# Checks for libraries.\nPKG_CHECK_EXISTS([sndfile], [], [\n    AC_MSG_ERROR(Please install libsndfile.)\n])\n',
    );
    await build(h, 'libbs2b');
    expect(commands(h)).toEqual(
      [
        'autoreconf -fi',
        configureLine(h, [
          '--disable-shared',
          '--enable-static',
          '--with-pic',
          'ac_cv_func_malloc_0_nonnull=yes',
        ]),
        'make -j4 -C src libbs2b.la',
        'make -C src install-libLTLIBRARIES install-bs2bHEADERS',
        'make install-pkgconfigDATA',
      ].map((line) => line + o2(h)),
    );
    expect(h.read(join(h.src, 'configure.ac'))).toBe(
      'AM_INIT_AUTOMAKE([1.10.1 -Wall foreign subdir-objects\n                  dist-zip dist-bzip2])\n' +
        '# Checks for libraries.\n\n',
    );
  });
  it('is MIT, from the release tarball', () => {
    expect(recipe('libbs2b').license).toBe('MIT');
    expect(platformsOf('libbs2b')).toEqual(PLATFORMS);
  });
});

// libqrencode's library alone.
describe('libqrencode', () => {
  it.each(platformsOf('libqrencode'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libqrencode');
    expect(commands(h)).toEqual(
      cmakeLines(h, ['-DWITH_TOOLS=NO', '-DWITH_TESTS=NO', '-DWITHOUT_PNG=YES']),
    );
  });
});

// quirc's four library sources, built by a CMakeLists written for them.
describe('quirc', () => {
  it.each(platformsOf('quirc'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'quirc');
    expect(commands(h)).toEqual(cmakeLines(h, []));
    const lists = h.read(join(h.src, 'CMakeLists.txt'));
    expect(lists).toContain(
      'add_library(quirc STATIC lib/decode.c lib/identify.c lib/quirc.c lib/version_db.c)',
    );
    expect(lists).toContain('install(FILES lib/quirc.h DESTINATION include)');
  });
});

// Flite's libraries and headers: its configure without the old mingw and NDK toolchains, and no programs, tools or docs.
describe('flite', () => {
  const configure =
    `mingw*)\n                MINGWPREF="i386-mingw32-"\n                CC="\${MINGWPREF}gcc"\n` +
    `                RANLIB="\${MINGWPREF}ranlib"\n                AR="\${MINGWPREF}ar"\n` +
    `                WINDRES="\${MINGWPREF}windres"\n` +
    `android*)\n                CC="\${ANDROIDBIN}-gcc"\n                RANLIB="\${ANDROIDBIN}-ranlib"\n` +
    `                AR="\${ANDROIDBIN}-ar"\n                NM="\${ANDROIDBIN}-nm"\n\n        ;;\n`;
  it.each(platformsOf('flite'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'configure'), configure);
    put(
      join(h.src, 'Makefile'),
      'BUILD_DIRS = include src lang doc\nHOST_ONLY_DIRS = tools main\n',
    );
    put(join(h.src, 'include', 'cst_file.h'), '#ifdef _WIN32\n#define snprintf c99_snprintf\n');
    put(join(h.src, 'build', 'x86_64-linux-gnu', 'lib', 'libflite.a'), 'a');
    put(join(h.src, 'build', 'x86_64-linux-gnu', 'lib', 'libflite_cmu_us_slt.a'), 'a');
    await build(h, 'flite');
    expect(commands(h)).toEqual(
      [
        configureLine(h, [
          '--disable-shared',
          '--with-pic',
          '--with-audio=none',
          '--disable-sockets',
        ]),
        'make -j4',
      ].map((line) => line + o2(h)),
    );
    const configured = h.read(join(h.src, 'configure'));
    expect(configured).not.toMatch(/(CC|AR|RANLIB|NM)="\$\{(MINGWPREF|ANDROIDBIN)\}/);
    expect(configured).toContain(`WINDRES="\${MINGWPREF}windres"`);
    expect(h.read(join(h.src, 'Makefile'))).toBe(
      'BUILD_DIRS = include src lang\nHOST_ONLY_DIRS =\n',
    );
    expect(h.read(join(h.src, 'include', 'cst_file.h'))).toBe(
      '#if defined(_WIN32) && !defined(__MINGW32__)\n#define snprintf c99_snprintf\n',
    );
    expect(h.files(h.deps)).toEqual(
      expect.arrayContaining([
        'include/flite/cst_file.h',
        'lib/libflite.a',
        'lib/libflite_cmu_us_slt.a',
      ]),
    );
  });
  it('is under its own BSD-like licence, allowed in every build', () => {
    expect(recipe('flite').license).toBe('LicenseRef-flite');
  });
});

// libzvbi's library alone, its configure.ac without gettext's macros (remade), without libpng.
describe('zvbi', () => {
  const configureAc =
    'AM_ICONV_LINK\nif test "x$am_cv_func_iconv" != xyes; then\n' +
    'AM_GNU_GETTEXT_VERSION([0.21])\nAM_GNU_GETTEXT([external], [need-ngettext])\n' +
    'AC_CONFIG_FILES([\n  test/Makefile\n  po/Makefile.in\n  zvbi.spec\n])\n' +
    '    AC_LINK_IFELSE([AC_LANG_PROGRAM([[]], [[pthread_create();]])],[],[\n';
  it.each(platformsOf('zvbi'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'configure.ac'), configureAc);
    put(join(h.src, 'Makefile.am'), 'SUBDIRS += \\\n\tpo \\\n\tdoc\n');
    await build(h, 'zvbi');
    expect(commands(h)).toEqual(
      [
        'autoreconf -fi',
        configureLine(h, [
          '--disable-shared',
          '--enable-static',
          '--with-pic',
          '--disable-v4l',
          '--disable-dvb',
          '--disable-bktr',
          '--disable-proxy',
          '--disable-tests',
          '--disable-examples',
          '--without-doxygen',
          '--without-x',
          'ac_cv_lib_png_png_destroy_write_struct=no',
          'ac_cv_func_malloc_0_nonnull=yes',
          'ac_cv_func_realloc_0_nonnull=yes',
        ]),
        'make -j4 -C src',
        'make -C src install',
        'make install-pkgconfigDATA',
      ].map(
        (line) =>
          `${line} [CFLAGS=${env(h, 'CFLAGS')} -O2 CPPFLAGS=-I${h.deps}/include ${env(h, 'CPPFLAGS')} LDFLAGS=-L${h.deps}/lib ${env(h, 'LDFLAGS')}]`,
      ),
    );
    expect(h.read(join(h.src, 'configure.ac'))).toBe(
      'AC_SEARCH_LIBS([libiconv_open], [iconv], [am_cv_func_iconv=yes],\n' +
        '  [AC_SEARCH_LIBS([iconv_open], [iconv], [am_cv_func_iconv=yes])])\n' +
        'if test "x$am_cv_func_iconv" != xyes; then\n' +
        'AC_CONFIG_FILES([\n  test/Makefile\n  zvbi.spec\n])\n' +
        '    AC_LINK_IFELSE([AC_LANG_PROGRAM([[#include <pthread.h>]], [[pthread_create(0, 0, 0, 0);]])],[],[\n',
    );
    expect(h.read(join(h.src, 'Makefile.am'))).toBe('SUBDIRS += \\\n\tdoc\n');
  });
  it('is GPL-2.0-only in part, and takes GNU libiconv where the C library has no iconv', () => {
    expect(recipe('zvbi').license).toContain('GPL-2.0-only');
    expect(recipe('zvbi').needs).toEqual([
      { name: 'libiconv', platforms: ['win-*', 'osx-*', 'ios-*', 'maccatalyst-*'] },
    ]);
  });
});

// aribb24 1.0.4 (VideoLAN's fork), without libpng, its configure made after that edit.
describe('aribb24', () => {
  it.each(platformsOf('aribb24'))('%s', async (platform) => {
    const h = fake(platform);
    put(
      join(h.src, 'configure.ac'),
      'pkg_requires=""\nPKG_CHECK_MODULES(PNG, "libpng", [\n  AC_DEFINE(HAVE_PNG, 1, "have libpng")\n' +
        '  pkg_requires="libpng"\n], [])\n\nAC_CHECK_FUNCS([vasprintf])\n',
    );
    await build(h, 'aribb24');
    expect(commands(h)).toEqual(
      [
        'autoreconf -fi',
        configureLine(h, ['--disable-shared', '--enable-static', '--with-pic']),
        'make -j4',
        'make install',
      ].map((line) => line + o2(h)),
    );
    expect(h.read(join(h.src, 'configure.ac'))).toBe(
      'pkg_requires=""\n\n\nAC_CHECK_FUNCS([vasprintf])\n',
    );
  });
  it('is LGPL-3.0-or-later', () => {
    expect(recipe('aribb24').license).toBe('LGPL-3.0-or-later');
  });
});

// libaribcaption with its renderer, on CMake 3.11's terms; on Android its .pc names the FreeType it renders with.
describe('libaribcaption', () => {
  it.each(platformsOf('libaribcaption'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.28)\n');
    const pc = `Requires: \nRequires.private:\nLibs: -L\${libdir} -laribcaption -lc++\n`;
    put(pcPath(h, 'libaribcaption'), pc);
    await build(h, 'libaribcaption');
    expect(commands(h)).toEqual(
      cmakeLines(h, ['-DARIBCC_BUILD_TESTS=OFF', '-DARIBCC_SHARED_LIBRARY=OFF']),
    );
    expect(h.read(join(h.src, 'CMakeLists.txt'))).toBe('cmake_minimum_required(VERSION 3.11)\n');
    expect(h.read(pcPath(h, 'libaribcaption'))).toBe(
      platform.startsWith('android-')
        ? pc.replace('Requires.private:', 'Requires.private: freetype2')
        : pc,
    );
  });
  it('takes FreeType on Linux and Android, and Fontconfig on Linux', () => {
    expect(recipe('libaribcaption').needs).toEqual([
      { name: 'freetype', platforms: ['linux-*', 'android-*'] },
      { name: 'fontconfig', platforms: ['linux-*'] },
    ]);
  });
});
