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

/** The C++ runtime a static link needs, as `{cxx-runtime}` names it. */
const cxxRuntime = (platform: string) => {
  if (/^(osx|ios|maccatalyst|android)-/.test(platform)) {
    return '-lc++';
  }
  if (platform === 'win-arm64') {
    return '-l:libc++.a';
  }
  return platform.startsWith('linux-musl-') ? '-l:libstdc++.a' : '-lstdc++';
};

// Rubber Band's library alone, its own FFT (vDSP on Apple) and resampler; the C++ runtime and libm in its .pc.
describe('rubberband', () => {
  it.each(platformsOf('rubberband'))('%s', async (platform) => {
    const h = fake(platform);
    h.onRun = (call) => {
      if (call.command === 'meson' && call.args[0] === 'install') {
        put(pcPath(h, 'rubberband'), `Libs: -L\${libdir} -lrubberband\nCflags: -I\${includedir}\n`);
      }
      return undefined;
    };
    await build(h, 'rubberband');
    const apple = /^(osx|ios|maccatalyst)-/.test(platform);
    expect(commands(h)).toEqual(
      mesonLines(h, [
        '-Dresampler=builtin',
        '-Djni=disabled',
        '-Dladspa=disabled',
        '-Dlv2=disabled',
        '-Dvamp=disabled',
        '-Dcmdline=disabled',
        '-Dtests=disabled',
        apple ? '-Dfft=vdsp' : '-Dfft=builtin',
      ]),
    );
    expect(h.read(pcPath(h, 'rubberband'))).toBe(
      `Libs: -L\${libdir} -lrubberband\nLibs.private: ${cxxRuntime(platform)} -lm\nCflags: -I\${includedir}\n`,
    );
  });
  it('is GPL-2.0-or-later, and builds everywhere', () => {
    expect(recipe('rubberband').license).toBe('GPL-2.0-or-later');
    expect(platformsOf('rubberband')).toEqual(PLATFORMS);
  });
});

// The plugin hosts' headers: frei0r.h and ladspa.h, nothing built.
describe('frei0r and ladspa-sdk', () => {
  it.each(platformsOf('frei0r'))('frei0r on %s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'include', 'frei0r.h'), 'f0r');
    await build(h, 'frei0r');
    expect(commands(h)).toEqual([]);
    expect(h.files(h.deps)).toContain('include/frei0r.h');
  });
  it.each(platformsOf('ladspa-sdk'))('ladspa-sdk on %s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'src', 'ladspa.h'), 'ladspa');
    await build(h, 'ladspa-sdk');
    expect(commands(h)).toEqual([]);
    expect(h.files(h.deps)).toContain('include/ladspa.h');
  });
  it('LADSPA is not on Windows (FFmpeg loads its plugins with dlopen); frei0r is GPL, everywhere', () => {
    expect(platformsOf('ladspa-sdk')).toEqual(PLATFORMS.filter((p) => !p.startsWith('win-')));
    expect(recipe('frei0r').license).toBe('GPL-2.0-or-later');
    expect(platformsOf('frei0r')).toEqual(PLATFORMS);
  });
});

// The LV2 host stack: lilv on zix, serd, sord, sratom and the LV2 headers, each the library alone.
describe('the LV2 host stack', () => {
  const args: Record<string, string[]> = {
    lv2: ['-Dplugins=disabled', '-Ddocs=disabled', '-Dtests=disabled', '-Donline_docs=false'],
    zix: ['-Dbenchmarks=disabled', '-Ddocs=disabled', '-Dtests=disabled', '-Dtests_cpp=disabled'],
    serd: ['-Dtools=disabled', '-Dman=disabled', '-Ddocs=disabled', '-Dtests=disabled'],
    sord: [
      '-Dtools=disabled',
      '-Dbindings_cpp=disabled',
      '-Dman=disabled',
      '-Ddocs=disabled',
      '-Dtests=disabled',
    ],
    sratom: ['-Ddocs=disabled', '-Dtests=disabled'],
    lilv: [
      '-Dtools=disabled',
      '-Dbindings_py=disabled',
      '-Dbindings_cpp=disabled',
      '-Ddocs=disabled',
      '-Dtests=disabled',
      '-Ddynmanifest=disabled',
    ],
  };
  const builds = Object.keys(args).flatMap((name) =>
    platformsOf(name).map((p) => [name, p] as const),
  );
  it.each(builds)('%s on %s', async (name, platform) => {
    const h = fake(platform);
    await build(h, name);
    expect(commands(h)).toEqual(mesonLines(h, args[name]!));
  });
  it('is ISC throughout, on every platform, lilv on the rest', () => {
    for (const name of Object.keys(args)) {
      expect(recipe(name).license, name).toBe('ISC');
      expect(platformsOf(name), name).toEqual(PLATFORMS);
    }
    expect(recipe('lilv').needs.map((n) => n.name)).toEqual([
      'zix',
      'serd',
      'sord',
      'sratom',
      'lv2',
    ]);
    expect(recipe('lilv').provides).toBe('lv2');
  });
});

const apple = (p: string) => /^(osx|ios|maccatalyst)-/.test(p);

// GLib and what it builds on: PCRE2 (8-bit, no JIT), libffi, and proxy-libintl's stubs where the C library has no
// gettext; nothing fetched as a subproject.
describe('GLib', () => {
  it.each(platformsOf('pcre2'))('pcre2 on %s', async (platform) => {
    const h = fake(platform);
    await build(h, 'pcre2');
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DPCRE2_BUILD_PCRE2_8=ON',
        '-DPCRE2_BUILD_PCRE2_16=OFF',
        '-DPCRE2_BUILD_PCRE2_32=OFF',
        '-DPCRE2_BUILD_PCRE2GREP=OFF',
        '-DPCRE2_BUILD_TESTS=OFF',
        '-DPCRE2_SUPPORT_JIT=OFF',
        '-DPCRE2_STATIC_PIC=ON',
      ]),
    );
  });
  it.each(platformsOf('libffi'))('libffi on %s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libffi');
    expect(commands(h)).toEqual([
      configureLine(h, [
        '--disable-shared',
        '--enable-static',
        '--with-pic',
        '--disable-docs',
        '--disable-multi-os-directory',
        `--libdir=${h.deps}/lib`,
      ]),
      'make -j4',
      'make install',
    ]);
  });
  it.each(platformsOf('proxy-libintl'))('proxy-libintl on %s', async (platform) => {
    const h = fake(platform);
    const header =
      '#if defined(_WIN32) && !defined(G_INTL_STATIC_COMPILATION)\n#  define G_INTL_EXPORT __declspec(dllimport)\n';
    put(join(h.deps, 'include', 'libintl.h'), header);
    await build(h, 'proxy-libintl');
    expect(commands(h)).toEqual(mesonLines(h, []));
    expect(h.read(join(h.deps, 'include', 'libintl.h'))).toBe(
      '#if 0 /* static: ffmpeg-build */\n#  define G_INTL_EXPORT __declspec(dllimport)\n',
    );
  });
  it.each(platformsOf('glib'))('glib on %s', async (platform) => {
    const h = fake(platform);
    await build(h, 'glib');
    // native builds (musl, osx-arm64): deps' folders for meson's libintl search
    const native = /^linux-musl-|^osx-arm64$/.test(platform)
      ? ` [CPPFLAGS=-I${h.deps}/include ${env(h, 'CPPFLAGS')} LDFLAGS=-L${h.deps}/lib ${env(h, 'LDFLAGS')}]`
      : '';
    // Apple cross builds: a second cross file names the Objective-C compiler
    const objc = /^(osx-x64|ios-|maccatalyst-)/.test(platform);
    expect(commands(h)).toEqual(
      mesonLines(h, [
        '--wrap-mode=nofallback',
        '-Dtests=false',
        '-Dinstalled_tests=false',
        '-Ddocumentation=false',
        '-Dman-pages=disabled',
        '-Dintrospection=disabled',
        '-Dnls=disabled',
        '-Dselinux=disabled',
        '-Dlibmount=disabled',
        '-Dxattr=false',
        '-Dsysprof=disabled',
        '-Ddtrace=disabled',
        '-Dsystemtap=disabled',
        '-Dlibelf=disabled',
        '-Dglib_debug=disabled',
        ...(objc ? [`--cross-file=${h.src}/objc-cross.ini`] : []),
      ]).map((line) => line + native),
    );
    const ini = objc ? h.read(join(h.src, 'objc-cross.ini')) : '';
    expect(ini.includes(`objc = '${env(h, 'CC')}'`)).toBe(objc);
    expect(ini.includes(`'-I${h.deps}/include']`)).toBe(objc);
  });
  it('takes proxy-libintl wherever the C library is not glibc, GNU libiconv on Apple, and 2.86', () => {
    const noGettext = PLATFORMS.filter((p) => !/^linux-(x64|arm64|armhf)$/.test(p));
    expect(platformsOf('proxy-libintl')).toEqual(noGettext);
    expect(recipe('glib').needs).toEqual([
      { name: 'zlib' },
      { name: 'pcre2' },
      { name: 'libffi' },
      {
        name: 'proxy-libintl',
        platforms: ['linux-musl-*', 'win-*', 'osx-*', 'ios-*', 'maccatalyst-*', 'android-*'],
      },
      { name: 'libiconv', platforms: ['osx-*', 'ios-*', 'maccatalyst-*'] },
    ]);
    expect(recipe('pcre2').license).toBe('BSD-3-Clause WITH PCRE2-exception');
  });
});

// Lensfun from master (FFmpeg's filter uses the coming 0.4 API), without its database, Python module or programs.
describe('lensfun', () => {
  it.each(platformsOf('lensfun'))('%s', async (platform) => {
    const h = fake(platform);
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        put(
          pcPath(h, 'lensfun'),
          `Requires.private: glib-2.0\nLibs: -L\${libdir} -llensfun\nCflags: -I\${includedir}\n`,
        );
        put(join(h.deps, 'share', 'lensfun', 'version_2', 'mil-sony.xml'), '<lensdatabase/>');
      }
      return undefined;
    };
    await build(h, 'lensfun');
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DBUILD_STATIC=ON',
        '-DBUILD_TESTS=OFF',
        '-DBUILD_LENSTOOL=OFF',
        '-DBUILD_DOC=OFF',
        '-DINSTALL_PYTHON_MODULE=OFF',
        '-DINSTALL_HELPER_SCRIPTS=OFF',
        '-DCMAKE_INSTALL_DATAROOTDIR=share',
        '-DPYTHON=PYTHON-NOTFOUND',
      ]),
    );
    expect(h.files(h.deps).filter((f) => f.startsWith('share/'))).toEqual([]);
    const win = platform.startsWith('win-') ? ' -DCONF_LENSFUN_STATIC' : '';
    expect(h.read(pcPath(h, 'lensfun'))).toBe(
      `Requires.private: glib-2.0\nLibs: -L\${libdir} -llensfun\nLibs.private: ${cxxRuntime(platform)}\nCflags: -I\${includedir}${win}\n`,
    );
  });
  it('is the library alone, LGPL-3.0-or-later, from master', () => {
    expect(recipe('lensfun').license).toBe('LGPL-3.0-or-later');
    expect(recipe('lensfun').versions).toEqual({ 'git-branch': 'master' });
  });
});

// OpenColorIO on its own recipes (nothing fetched), its .pc completed for a static link.
describe('OpenColorIO', () => {
  it.each(platformsOf('opencolorio'))('%s', async (platform) => {
    const h = fake(platform);
    put(
      join(h.src, 'src', 'OpenColorIO', 'transforms', 'FileTransform.cpp'),
      '    return std::unique_ptr<std::istream>(new std::ifstream(\n        Platform::filenameToUTF(filepath), mode));\n',
    );
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        put(
          pcPath(h, 'OpenColorIO'),
          `Libs: -L\${libdir} -lOpenColorIO\nCflags: -I\${includedir}\n`,
        );
      }
      return undefined;
    };
    await build(h, 'opencolorio');
    const arm = /-arm64$|^linux-armhf$/.test(platform);
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DOCIO_INSTALL_EXT_PACKAGES=NONE',
        '-DOCIO_BUILD_APPS=OFF',
        '-DOCIO_BUILD_OPENFX=OFF',
        '-DOCIO_BUILD_NUKE=OFF',
        '-DOCIO_BUILD_TESTS=OFF',
        '-DOCIO_BUILD_GPU_TESTS=OFF',
        '-DOCIO_BUILD_DOCS=OFF',
        '-DOCIO_BUILD_PYTHON=OFF',
        '-DOCIO_BUILD_JAVA=OFF',
        '-DOCIO_USE_SOVERSION=OFF',
        ...(platform.startsWith('android-') ? [`-DCMAKE_FIND_ROOT_PATH=${h.deps}`] : []),
        ...(arm ? ['-DOCIO_USE_SIMD=OFF'] : []),
      ]),
    );
    const win = platform.startsWith('win-');
    expect(h.read(join(h.src, 'src', 'OpenColorIO', 'transforms', 'FileTransform.cpp'))).toContain(
      win
        ? 'Platform::filenameToUTF(filepath).c_str(), mode));'
        : 'Platform::filenameToUTF(filepath), mode));',
    );
    expect(h.read(pcPath(h, 'OpenColorIO'))).toBe(
      `Libs: -L\${libdir} -lOpenColorIO\n` +
        `Libs.private: -lpystring ${cxxRuntime(platform)} -lm${win ? ' -lgdi32 -luser32' : ''}\n` +
        `Cflags: -I\${includedir}${win ? ' -DOpenColorIO_SKIP_IMPORTS' : ''}\n` +
        'Requires.private: yaml-cpp minizip-ng Imath expat zlib\n',
    );
  });
  // not Apple (#41, and iOS's missing macOS APIs): its dependencies build where it does
  const notApple = PLATFORMS.filter((p) => /^(linux|win|android)-/.test(p));
  it.each(['opencolorio', 'yaml-cpp', 'pystring', 'imath', 'minizip-ng'])(
    '%s builds on Linux, Windows and Android',
    (name) => {
      expect(platformsOf(name)).toEqual(notApple);
    },
  );
  it('takes libexpat, which now builds on Windows and Android too', () => {
    expect(platformsOf('libexpat')).toEqual(
      PLATFORMS.filter((p) => /^(linux|osx|win|android)-/.test(p)),
    );
  });
});

// cairo with cairo-gobject and the platform's fonts, on pixman.
describe('cairo', () => {
  const fonts = (p: string) => {
    if (p.startsWith('linux-')) {
      return [
        '-Dfreetype=enabled',
        '-Dfontconfig=enabled',
        '-Dquartz=disabled',
        '-Ddwrite=disabled',
      ];
    }
    // FreeType alone on Android, iOS and Mac Catalyst (cairo's Quartz backend is macOS's)
    if (/^(android|ios|maccatalyst)-/.test(p)) {
      return [
        '-Dfreetype=enabled',
        '-Dfontconfig=disabled',
        '-Dquartz=disabled',
        '-Ddwrite=disabled',
      ];
    }
    if (p.startsWith('win-')) {
      return [
        '-Dfreetype=disabled',
        '-Dfontconfig=disabled',
        '-Dquartz=disabled',
        '-Ddwrite=enabled',
      ];
    }
    return [
      '-Dfreetype=disabled',
      '-Dfontconfig=disabled',
      '-Dquartz=enabled',
      '-Ddwrite=disabled',
    ];
  };
  it.each(platformsOf('cairo'))('%s', async (platform) => {
    const h = fake(platform);
    put(
      pcPath(h, 'cairo'),
      `Libs: -L\${libdir} -lcairo\nLibs.private: -lgdi32\nCflags: -I\${includedir}/cairo\n`,
    );
    await build(h, 'cairo');
    expect(commands(h)).toEqual(
      mesonLines(h, [
        '-Dtests=disabled',
        '-Dxlib=disabled',
        '-Dxcb=disabled',
        '-Dxlib-xcb=disabled',
        '-Dzlib=enabled',
        '-Dpng=enabled',
        '-Dglib=enabled',
        '-Dlzo=disabled',
        '-Dspectre=disabled',
        '-Dsymbol-lookup=disabled',
        '-Dgtk2-utils=disabled',
        '--wrap-mode=nofallback',
        ...fonts(platform),
      ]),
    );
    const win = platform.startsWith('win-');
    expect(h.read(pcPath(h, 'cairo'))).toBe(
      win
        ? // the C++ runtime by its plain name, which Rust's pkg-config parsing (librsvg's cairo-sys) also takes
          `Libs: -L\${libdir} -lcairo\nLibs.private: -lgdi32 -lole32 ${platform === 'win-arm64' ? '-lc++' : '-lstdc++'}\nCflags: -I\${includedir}/cairo -DCAIRO_WIN32_STATIC_BUILD\n`
        : `Libs: -L\${libdir} -lcairo\nLibs.private: -lgdi32\nCflags: -I\${includedir}/cairo\n`,
    );
  });
  it.each(platformsOf('pixman'))('pixman on %s', async (platform) => {
    const h = fake(platform);
    await build(h, 'pixman');
    expect(commands(h)).toEqual(
      mesonLines(h, [
        '-Dtests=disabled',
        '-Ddemos=disabled',
        '-Dgtk=disabled',
        '-Dlibpng=disabled',
        '-Dopenmp=disabled',
      ]),
    );
  });
  it('is LGPL-2.1-only OR MPL-1.1, on GLib, Fontconfig on Linux only', () => {
    expect(recipe('cairo').license).toBe('LGPL-2.1-only OR MPL-1.1');
    expect(recipe('cairo').needs.map((n) => n.name)).toContain('glib');
    expect(apple('osx-arm64')).toBe(true);
  });
});
