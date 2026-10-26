// Batch d of #21 (filters and processing): each library's build on every platform it builds on, with the process
// runner stubbed, and the files it leaves in deps.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeCargo } from './cargo-fake.ts';
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
import { runRecipe } from '../src/build/library.ts';
import { linkedRecipe } from '../src/linkage.ts';
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
      // as upstream wraps it, the value on a line of its own
      `  PROPERTIES OUTPUT_NAME mysofa CLEAN_DIRECT_OUTPUT 1 POSITION_INDEPENDENT_CODE\n                                                      \${BUILD_SHARED_LIBS})\n`,
    );
    put(
      join(h.src, 'src', 'config.h.in'),
      `#define CMAKE_INSTALL_PREFIX "\${CMAKE_INSTALL_PREFIX}"\n#define CPACK_PACKAGE_VERSION_MAJOR 1\n`,
    );
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        put(
          pcPath(h, 'libmysofa'),
          `includedir=/usr/include\nlibdir=/usr/lib\nLibs: -L\${libdir} -lmysofa\nCflags: -I\${includedir}\n\nLibs.private: \n`,
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
        '-DCMAKE_INSTALL_PREFIX=/usr',
        '-DCMAKE_C_FLAGS_RELEASE=-O3 -DNDEBUG -fPIC',
      ]).map((line) => (line === 'cmake --install _build' ? `${line} --prefix ${h.deps}` : line)),
    );
    expect(h.read(join(h.src, 'src', 'CMakeLists.txt'))).toContain(`\${BUILD_SHARED_LIBS})`);
    // no deps folder in the library: the default SOFA file is looked for where systems keep it
    expect(h.read(join(h.src, 'src', 'config.h.in'))).toBe(
      `#define CMAKE_INSTALL_PREFIX "\${CMAKE_INSTALL_PREFIX}"\n#define CPACK_PACKAGE_VERSION_MAJOR 1\n`,
    );
    expect(h.files(h.deps)).not.toContain('share/libmysofa/default.sofa');
    expect(h.read(pcPath(h, 'libmysofa'))).toBe(
      `includedir=${h.deps}/include\nlibdir=${h.deps}/lib\nLibs: -L\${libdir} -lmysofa\nCflags: -I\${includedir}\n\nLibs.private: -lz -lm\n`,
    );
  });
  it('needs zlib', () => {
    expect(recipe('libmysofa').needs).toEqual([{ name: 'zlib' }]);
  });
});

// libbs2b's release configuration and real libsndfile dependency, with GNU auxiliary-tool refresh only.
describe('libbs2b', () => {
  it.each(platformsOf('libbs2b'))('%s', async (platform) => {
    const h = fake(platform);
    put(
      join(h.src, 'configure.ac'),
      'AM_INIT_AUTOMAKE([1.10.1 -Wall foreign subdir-objects\n                  dist-zip dist-bzip2 dist-lzma])\n' +
        '# Checks for libraries.\nPKG_CHECK_EXISTS([sndfile], [], [\n    AC_MSG_ERROR(Please install libsndfile.)\n])\n',
    );
    const upstream = h.read(join(h.src, 'configure.ac'));
    await build(h, 'libbs2b');
    expect(commands(h)[0]).toContain('libbs2b');
    expect(commands(h)[0]).toContain('prepare-build-tools.py');
    expect(commands(h).slice(1)).toEqual(
      [
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
    expect(h.read(join(h.src, 'configure.ac'))).toBe(upstream);
  });
  it('is MIT, from the release tarball', () => {
    expect(recipe('libbs2b').license).toBe('MIT');
    expect(platformsOf('libbs2b')).toEqual(PLATFORMS);
    expect(recipe('libbs2b').needs).toEqual([{ name: 'libsndfile' }]);
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

// Quirc's native object rules and cross archiver, with no authored build-system adapter.
describe('quirc', () => {
  it('packages native shared output without changing bytes or invoking the host archiver', async () => {
    const h = fake('linux-x64');
    put(join(h.src, 'lib', 'quirc.h'), '/* native public header */\n');
    const native = 'native shared library bytes';
    h.onRun = (call) => {
      if (call.command === 'make' && call.args.includes('libquirc.so')) {
        put(join(h.src, `libquirc.so.${h.base['VERSION']!}`), native);
      }
      return undefined;
    };
    await runRecipe(
      h.context,
      {
        name: 'quirc',
        version: h.base['VERSION']!,
        build: linkedRecipe(recipe('quirc'), 'shared').build,
      },
      h.src,
    );
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.args).toContain(
      `LDFLAGS=${env(h, 'LDFLAGS')} -Wl,-soname,libquirc.so.${h.base['VERSION']!} -Wl,-z,defs`,
    );
    expect(h.read(join(h.deps, 'lib', 'libquirc.so'))).toBe(native);
    expect(h.read(join(h.deps, 'lib', `libquirc.so.${h.base['VERSION']!}`))).toBe(native);
    expect(h.files(h.src)).not.toContain('CMakeLists.txt');
  });
  it.each(platformsOf('quirc'))('%s', async (platform) => {
    const h = fake(platform);
    const makefile = 'LIB_OBJ = lib/decode.o lib/identify.o lib/quirc.o lib/version_db.o\n';
    put(join(h.src, 'Makefile'), makefile);
    put(join(h.src, 'lib', 'quirc.h'), '/* native public header */\n');
    h.onRun = (call) => {
      if (call.args[0] === 'cru') {
        put(join(h.src, 'libquirc.a'), '!<arch>\n');
      }
      return undefined;
    };
    await build(h, 'quirc');
    const tools = h.context.env['CROSS_HOST'] ? `${h.context.env['CROSS_HOST']}-` : '';
    const objects = 'lib/decode.o lib/identify.o lib/quirc.o lib/version_db.o';
    expect(commands(h)).toEqual([
      `make -j4 CC=${h.context.env['CC'] ?? `${tools}gcc`} CFLAGS=-O2 -fPIC ${h.context.env['CFLAGS'] ?? ''} SDL_CFLAGS= OPENCV_CFLAGS= ${objects}`,
      `${h.context.env['AR'] ?? `${tools}ar`} cru libquirc.a ${objects}`,
      `${h.context.env['RANLIB'] ?? `${tools}ranlib`} libquirc.a`,
    ]);
    expect(h.read(join(h.src, 'Makefile'))).toBe(makefile);
    expect(h.files(h.src)).not.toContain('CMakeLists.txt');
    expect(h.read(join(h.deps, 'include', 'quirc.h'))).toBe('/* native public header */\n');
    expect(h.read(join(h.deps, 'lib', 'libquirc.a'))).toBe('!<arch>\n');
  });
});

// Flite's unchanged native configure and headers, with no programs, tools or docs.
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
        'make -C include -j4',
        'make -C src -j4',
        'make -C lang -j4',
      ].map((line) => line + o2(h)),
    );
    const configured = h.read(join(h.src, 'configure'));
    expect(configured).toBe(configure);
    expect(h.read(join(h.src, 'Makefile'))).toBe(
      'BUILD_DIRS = include src lang doc\nHOST_ONLY_DIRS = tools main\n',
    );
    expect(h.read(join(h.src, 'include', 'cst_file.h'))).toBe(
      '#ifdef _WIN32\n#define snprintf c99_snprintf\n',
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

// libzvbi's library alone, with native gettext bootstrap and configure-time feature selection.
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
    const android = platform.startsWith('android-');
    const apple = /^(osx|ios|maccatalyst)-/.test(platform);
    const gettext = `${env(h, 'HOMEBREW_PREFIX') || '/opt/homebrew'}/opt/gettext`;
    expect(commands(h)).toEqual(
      [
        'autopoint --force',
        'autoreconf -fi',
        configureLine(h, [
          '--disable-shared',
          '--enable-static',
          '--with-pic',
          '--disable-nls',
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
          `${line} [${apple ? `ACLOCAL_PATH=${gettext}/share/aclocal:${env(h, 'ACLOCAL_PATH')} ` : ''}CFLAGS=${env(h, 'CFLAGS')} -O2${android ? ' -Wno-error=implicit-function-declaration' : ''} CPPFLAGS=-I${h.deps}/include ${env(h, 'CPPFLAGS')} LDFLAGS=-L${h.deps}/lib ${env(h, 'LDFLAGS')}${apple ? ` PATH=${gettext}/bin:${env(h, 'PATH')}` : ''}]`,
      ),
    );
    expect(h.read(join(h.src, 'configure.ac'))).toBe(configureAc);
    expect(h.read(join(h.src, 'Makefile.am'))).toBe('SUBDIRS += \\\n\tpo \\\n\tdoc\n');
  });
  it('is GPL-2.0-only in part, and takes GNU libiconv where the C library has no iconv', () => {
    expect(recipe('zvbi').license).toContain('GPL-2.0-only');
    expect(recipe('zvbi').needs).toEqual([
      { name: 'libiconv', platforms: ['win-*', 'osx-*', 'ios-*', 'maccatalyst-*'] },
    ]);
  });
});

// aribb24 1.0.4 (VideoLAN's fork), with its native PNG feature and math-library link flags.
describe('aribb24', () => {
  it.each(platformsOf('aribb24'))('%s', async (platform) => {
    const h = fake(platform);
    put(
      join(h.src, 'configure.ac'),
      'pkg_requires=""\nPKG_CHECK_MODULES(PNG, "libpng", [\n  AC_DEFINE(HAVE_PNG, 1, "have libpng")\n' +
        '  pkg_requires="libpng"\n], [])\n\nAC_CHECK_FUNCS([vasprintf])\n',
    );
    const source = h.read(join(h.src, 'configure.ac'));
    await build(h, 'aribb24');
    expect(commands(h)).toEqual(
      [
        'autoreconf -fi',
        configureLine(h, ['--disable-shared', '--enable-static', '--with-pic']),
        'make -j4',
        'make install',
      ].map((line) => `${line} [CFLAGS=${env(h, 'CFLAGS')} -O2 LIBS=${env(h, 'LIBS')} -lm]`),
    );
    expect(h.read(join(h.src, 'configure.ac'))).toBe(source);
  });
  it('is LGPL-3.0-or-later', () => {
    expect(recipe('aribb24').license).toBe('LGPL-3.0-or-later');
  });
});

// libaribcaption with its renderer and native CMake requirements; Android metadata names its FreeType dependency.
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
    expect(h.read(join(h.src, 'CMakeLists.txt'))).toBe('cmake_minimum_required(VERSION 3.28)\n');
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
    expect(h.read(join(h.deps, 'include', 'libintl.h'))).toBe(header);
  });
  it.each(platformsOf('glib'))('glib on %s', async (platform) => {
    const h = fake(platform);
    put(
      join(h.src, 'meson.build'),
      "glib_localedir = join_paths(glib_prefix, get_option('localedir'))\n",
    );
    await build(h, 'glib');
    // the system's folders, not deps', for translations and charset.alias
    expect(h.read(join(h.src, 'meson.build'))).toBe(
      "glib_localedir = join_paths(glib_prefix, get_option('localedir'))\n",
    );
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
        '-Dcharsetalias_dir=/usr/lib',
        '--localedir=/usr/share/locale',
        '--localstatedir=/var',
        ...(platform.startsWith('win-')
          ? [`-Dc_args=-I"${h.deps}/include" ${env(h, 'CFLAGS')} -DG_INTL_STATIC_COMPILATION`]
          : []),
        ...(objc ? [`--cross-file=${h.src}/objc-cross.ini`] : []),
      ]).map((line) => line + native),
    );
    const ini = objc ? h.read(join(h.src, 'objc-cross.ini')) : '';
    expect(ini.includes(`objc = '${env(h, 'CC')}'`)).toBe(objc);
    expect(ini.includes(`'-I${h.deps}/include']`)).toBe(objc);
  });
  it('takes proxy-libintl outside Linux and GNU libiconv on Apple', () => {
    const noGettext = PLATFORMS.filter((p) => !p.startsWith('linux-'));
    expect(platformsOf('proxy-libintl')).toEqual(noGettext);
    expect(recipe('glib').needs).toEqual([
      { name: 'zlib' },
      { name: 'pcre2' },
      { name: 'libffi' },
      {
        name: 'proxy-libintl',
        platforms: ['win-*', 'osx-*', 'ios-*', 'maccatalyst-*', 'android-*'],
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
    const config = join(h.src, 'include', 'lensfun', 'config.h.in.cmake');
    // as on master: Linux's and macOS's absolute, Windows' relative to the library
    const linux = `  #define SYSTEM_DB_PATH "\${CMAKE_INSTALL_FULL_DATAROOTDIR}/lensfun"\n`;
    const windows = `  #define SYSTEM_DB_PATH "\${CMAKE_INSTALL_DATAROOTDIR}/lensfun"\n`;
    put(config, linux + windows + linux);
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        put(
          pcPath(h, 'lensfun'),
          `prefix=/usr\nexec_prefix=\${prefix}\nlibdir=\${exec_prefix}/lib\nincludedir=\${prefix}/include\nRequires.private: glib-2.0\nLibs: -L\${libdir} -llensfun\nCflags: -I\${includedir}\n`,
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
        '-DCMAKE_INSTALL_PREFIX=/usr',
      ]).map((line) => (line === 'cmake --install _build' ? `${line} --prefix ${h.deps}` : line)),
    );
    expect(h.files(h.deps).filter((f) => f.startsWith('share/'))).toEqual([]);
    // the system's database by default, not the deps folder's (where none is)
    expect(h.read(config)).toBe(linux + windows + linux);
    const win = platform.startsWith('win-') ? ' -DCONF_LENSFUN_STATIC' : '';
    expect(h.read(pcPath(h, 'lensfun'))).toBe(
      `prefix=${h.deps}\nexec_prefix=\${prefix}\nlibdir=\${exec_prefix}/lib\nincludedir=\${prefix}/include\nRequires.private: glib-2.0\nLibs: -L\${libdir} -llensfun\nLibs.private: ${cxxRuntime(platform)}\nCflags: -I\${includedir}${win}\n`,
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
    const mac = platform.startsWith('osx-');
    expect(h.read(join(h.src, 'src', 'OpenColorIO', 'transforms', 'FileTransform.cpp'))).toContain(
      'Platform::filenameToUTF(filepath), mode));',
    );
    expect(h.read(pcPath(h, 'OpenColorIO'))).toBe(
      `Libs: -L\${libdir} -lOpenColorIO\n` +
        `Libs.private: -lpystring ${cxxRuntime(platform)} -lm${mac ? ' -framework ColorSync -framework CoreFoundation -framework CoreGraphics -framework IOKit' : ''}\n` +
        `Cflags: -I\${includedir}\n` +
        'Requires.private: yaml-cpp minizip-ng Imath expat zlib\n',
    );
  });
  // macOS too (the engine's fix for FFmpeg's VERSION file, #41), not iOS or Mac Catalyst (their missing macOS APIs):
  // its dependencies build where it does
  const notIos = PLATFORMS.filter((p) => /^(linux|osx|win|android)-/.test(p));
  it.each(['yaml-cpp', 'pystring', 'imath', 'minizip-ng'])(
    '%s builds on Linux, macOS, Windows and Android',
    (name) => {
      expect(platformsOf(name)).toEqual(notIos);
    },
  );
  it('omits the unsupported MinGW constructor in the current OpenColorIO release', () => {
    expect(platformsOf('opencolorio')).toEqual(notIos.filter((p) => !p.startsWith('win-')));
  });
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
    // Fontconfig on Android too: Pango's font map there needs cairo's
    if (p.startsWith('android-')) {
      return [
        '-Dfreetype=enabled',
        '-Dfontconfig=enabled',
        '-Dquartz=disabled',
        '-Ddwrite=disabled',
      ];
    }
    // FreeType alone on iOS and Mac Catalyst (cairo's Quartz backend is macOS's)
    if (/^(ios|maccatalyst)-/.test(p)) {
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
    const instrumentation = [
      'lib/cairo/libcairo-trace.so',
      'lib/cairo/libcairo-fdr.a',
      'bin/cairo-trace',
    ];
    for (const name of instrumentation) {
      put(join(h.deps, name), 'optional development instrumentation\n');
    }
    put(join(h.deps, 'lib', 'libcairo.a'), '!<arch>\n');
    put(
      pcPath(h, 'cairo'),
      `Libs: -L\${libdir} -lcairo\nLibs.private: -lgdi32\nCflags: -I\${includedir}/cairo\n`,
    );
    await build(h, 'cairo');
    expect(instrumentation.map((name) => existsSync(join(h.deps, name)))).toEqual([
      false,
      false,
      false,
    ]);
    expect(h.read(join(h.deps, 'lib', 'libcairo.a'))).toBe('!<arch>\n');
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
  it('is LGPL-2.1-only OR MPL-1.1, on GLib, Fontconfig on Linux and Android', () => {
    expect(recipe('cairo').license).toBe('LGPL-2.1-only OR MPL-1.1');
    expect(recipe('cairo').needs.map((n) => n.name)).toContain('glib');
    expect(recipe('cairo').needs).toContainEqual({
      name: 'fontconfig',
      platforms: ['linux-*', 'android-*'],
    });
    expect(platformsOf('fontconfig')).toEqual(
      PLATFORMS.filter((p) => /^(linux|osx|android)-/.test(p)),
    );
  });
});

// Pango uses its unchanged sources and GLib's native enum generator. Windows ARM64
// keeps the generated parent-class warning visible without treating it as an error.
describe('pango', () => {
  it.each(platformsOf('pango'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'pango', 'pangofc-fontmap.c'), '#include <hb-ft.h>\n');
    put(join(h.src, 'meson.build'), "    '-Werror=unused-but-set-variable',\n");
    await build(h, 'pango');
    const fc = /^(linux|android)-/.test(platform) ? 'enabled' : 'disabled';
    expect(commands(h)).toEqual(
      mesonLines(h, [
        '--wrap-mode=nofallback',
        '-Dintrospection=disabled',
        '-Ddocumentation=false',
        '-Dman-pages=false',
        '-Dbuild-testsuite=false',
        '-Dbuild-examples=false',
        '-Dsysprof=disabled',
        '-Dlibthai=disabled',
        '-Dxft=disabled',
        '-Dcairo=enabled',
        `-Dfontconfig=${fc}`,
        `-Dfreetype=${fc}`,
        ...(platform === 'win-arm64' ? ['-Dc_args=-Xclang -Wno-error=unused-but-set-global'] : []),
      ]).map((line) => `${line} [PATH=${h.deps}/bin:${env(h, 'PATH')}]`),
    );
    expect(h.read(join(h.src, 'pango', 'pangofc-fontmap.c'))).toBe('#include <hb-ft.h>\n');
    expect(h.read(join(h.src, 'meson.build'))).toBe("    '-Werror=unused-but-set-variable',\n");
  });
  it('stays on 1.56 while GLib does on 2.86, and leaves out Apple', () => {
    expect(recipe('pango').versions).toEqual({ 'git-tags': '^(1\\.56\\.\\d+)$' });
    expect(platformsOf('pango')).toEqual(
      PLATFORMS.filter((p) => !/^(osx|ios|maccatalyst)-/.test(p)),
    );
  });
});

// librsvg's Rust library through its meson and cargo-c, for the platform's Rust target.
describe('librsvg', () => {
  const targets: Record<string, string> = {
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-musl-x64': 'x86_64-unknown-linux-musl',
    'linux-musl-arm64': 'aarch64-unknown-linux-musl',
    'linux-armhf': 'armv7-unknown-linux-gnueabihf',
    'win-x64': 'x86_64-pc-windows-gnu',
    'win-arm64': 'aarch64-pc-windows-gnullvm',
    'android-arm64': 'aarch64-linux-android',
    'android-x64': 'x86_64-linux-android',
  };
  it.each(platformsOf('librsvg'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'meson.build'), '  foreach i: native_libs.stdout().split()\n');
    fakeCargo(h, { name: 'librsvg-c', version: '2.63.3', license: 'LGPL-2.1-or-later' }, [
      { name: 'librsvg', version: '2.63.3', license: 'LGPL-2.1-or-later', path: 'rsvg' },
      { name: 'nalgebra', version: '0.34.0', license: 'Apache-2.0', files: { LICENSE: 'a' } },
      { name: 'selectors', version: '0.40.0', license: 'MPL-2.0' },
    ]);
    await build(h, 'librsvg');
    // its crates for the platform's Rust target, before meson; meson's cargo then builds offline
    const lines = commands(h);
    expect(lines.findIndex((l) => l.startsWith('cargo fetch'))).toBeLessThan(
      lines.findIndex((l) => l.startsWith('meson setup')),
    );
    expect(lines.find((l) => l.startsWith('cargo tree'))).toContain(
      `-p librsvg-c --target ${targets[platform]!}`,
    );
    expect(h.calls.find((c) => c.command === 'meson')!.env['CARGO_NET_OFFLINE']).toBe('true');
    const setup = commands(h).find((line) => line.startsWith('meson setup'))!;
    expect(setup).toContain(`-Dtriplet=${targets[platform]!}`);
    for (const arg of [
      '--wrap-mode=nofallback',
      '-Dpixbuf=disabled',
      '-Drsvg-convert=disabled',
      '-Davif=disabled',
    ]) {
      expect(setup).toContain(arg);
    }
    expect(setup).toContain('RUSTFLAGS=--remap-path-prefix=');
    expect(h.read(join(h.src, 'meson.build'))).toBe('  foreach i: native_libs.stdout().split()\n');
  });
  it('is v3 builds only, for its Apache-2.0 crates, and not on Apple', () => {
    expect(recipe('librsvg').license).toContain('Apache-2.0');
    expect(recipe('librsvg').provides).toBe('rsvg');
    expect(platformsOf('librsvg')).toEqual(platformsOf('pango'));
  });
});

// Tesseract's native Autotools library on Leptonica (zlib and PNG alone).
describe('tesseract', () => {
  it.each(platformsOf('leptonica'))('leptonica on %s', async (platform) => {
    const h = fake(platform);
    const win = platform.startsWith('win-');
    const nativeArchive = `libleptonica-${h.base['VERSION']!}.dll`;
    put(
      join(h.src, 'src', 'CMakeLists.txt'),
      'if(MINGW)\n  set_target_properties(\n    leptonica PROPERTIES SUFFIX\n',
    );
    if (win) {
      put(pcPath(h, 'lept_Release'), 'Libs: -lleptonica\n');
      put(join(h.deps, 'lib', nativeArchive), '!<arch>\n');
      h.onRun = (call) => (call.command === 'file' ? 'current ar archive\n' : undefined);
    }
    await build(h, 'leptonica');
    expect(commands(h)).toEqual([
      ...cmakeLines(h, [
        '-DBUILD_PROG=OFF',
        '-DSW_BUILD=OFF',
        '-DENABLE_ZLIB=ON',
        '-DENABLE_PNG=ON',
        '-DENABLE_GIF=OFF',
        '-DENABLE_JPEG=OFF',
        '-DENABLE_TIFF=OFF',
        '-DENABLE_WEBP=OFF',
        '-DENABLE_OPENJPEG=OFF',
      ]),
      ...(win ? [`file -b ${h.deps}/lib/${nativeArchive}`] : []),
    ]);
    expect(h.read(join(h.src, 'src', 'CMakeLists.txt'))).toBe(
      'if(MINGW)\n  set_target_properties(\n    leptonica PROPERTIES SUFFIX\n',
    );
    // Retain the native name for upstream's installed CMake target metadata.
    const installedArchives = win
      ? [nativeArchive, 'libleptonica.a'].map((name) => h.read(join(h.deps, 'lib', name)))
      : [];
    expect(installedArchives).toEqual(win ? ['!<arch>\n', '!<arch>\n'] : []);
    expect(h.files(h.deps).includes('lib/pkgconfig/lept.pc')).toBe(win);
  });
  it.each(platformsOf('tesseract'))('tesseract on %s', async (platform) => {
    const h = fake(platform);
    put(
      join(h.src, 'CMakeLists.txt'),
      'check_leptonica_tiff_support()\nset(LIB_Ws2_32 Ws2_32)\nelseif(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64.*|AARCH64.*")\n',
    );
    put(join(h.src, 'src', 'viewer', 'scrollview.h'), '#include <cstdio>\n');
    put(
      join(h.src, 'src', 'arch', 'simddetect.cpp'),
      '#include <numeric> // for std::inner_product\n',
    );
    h.onRun = (call) => {
      if (call.command === 'make' && call.args.includes('install-libLTLIBRARIES')) {
        put(
          pcPath(h, 'tesseract'),
          `Libs: -L\${libdir} -ltesseract\nLibs.private: -lpthread\nRequires.private: lept\n`,
        );
      }
      return undefined;
    };
    await build(h, 'tesseract');
    expect(commands(h)).toEqual(
      [
        'sh autogen.sh',
        configureLine(h, [
          '--disable-shared',
          '--enable-static',
          '--with-pic',
          '--disable-graphics',
          '--disable-doc',
          '--without-archive',
          '--without-curl',
          '--disable-openmp',
        ]),
        'make -j4 libtesseract.la',
        'make install-libLTLIBRARIES install-pkgincludeHEADERS install-pkgconfigDATA',
      ].map(
        (line) => `${line} [CXXFLAGS=${h.base['CXXFLAGS'] ?? ''} -include string -include cstdlib]`,
      ),
    );
    expect(h.read(join(h.src, 'CMakeLists.txt'))).toBe(
      'check_leptonica_tiff_support()\nset(LIB_Ws2_32 Ws2_32)\nelseif(CMAKE_SYSTEM_PROCESSOR MATCHES "arm64|aarch64.*|AARCH64.*")\n',
    );
    expect(h.read(join(h.src, 'src', 'viewer', 'scrollview.h'))).toBe('#include <cstdio>\n');
    expect(h.read(join(h.src, 'src', 'arch', 'simddetect.cpp'))).toBe(
      '#include <numeric> // for std::inner_product\n',
    );
    expect(h.read(pcPath(h, 'tesseract'))).toBe(
      `Libs: -L\${libdir} -ltesseract\nLibs.private: ${cxxRuntime(platform)} -lm${platform.startsWith('linux-') ? ' -pthread' : ''}${platform.startsWith('win-') ? ' -lws2_32' : ''}${/^(osx|ios|maccatalyst)-/.test(platform) ? ' -framework Accelerate' : ''}\nRequires.private: lept\n`,
    );
  });
  it('is Apache-2.0 and uses native CPU detection without the CMake-only NDK adapter', () => {
    expect(recipe('tesseract').license).toBe('Apache-2.0');
    expect(recipe('tesseract').needs).toEqual([{ name: 'leptonica' }]);
  });
});

// OpenCV's core and imgproc alone, in the usual layout everywhere, its .pc completed for a static link from C.
describe('opencv', () => {
  it.each(platformsOf('opencv'))('%s', async (platform) => {
    const h = fake(platform);
    const android = platform.startsWith('android-');
    const ios = platform.startsWith('ios-');
    const pc = `Libs: -L\${libdir} -lopencv_imgproc -lopencv_core\nLibs.private: -ldl -lm\n`;
    // not installed on Android: copied from the build folder
    if (!ios) {
      put(android ? join(h.src, '_build', 'unix-install', 'opencv4.pc') : pcPath(h, 'opencv4'), pc);
    }
    put(
      join(h.src, 'CMakeLists.txt'),
      `status("    C++ flags (Release):"    \${CMAKE_CXX_FLAGS} \${CMAKE_CXX_FLAGS_RELEASE})\n` +
        `  status("    Linker flags (Debug):"   \${CMAKE_EXE_LINKER_FLAGS} \${CMAKE_EXE_LINKER_FLAGS_DEBUG})\n` +
        `status("    Version control:" \${OPENCV_VCSVERSION})\n`,
    );
    put(
      join(h.src, 'cmake', 'OpenCVUtils.cmake'),
      `function(ocv_output_status msg)\n  message(STATUS "\${msg}")\n`,
    );
    put(
      join(h.src, 'modules', 'core', 'CMakeLists.txt'),
      `#define OPENCV_INSTALL_PREFIX \\"\${CMAKE_INSTALL_PREFIX}\\"\n#define OPENCV_BUILD_DIR \\"\${CMAKE_BINARY_DIR}\\"\n`,
    );
    put(join(h.src, 'cmake', 'OpenCVGenPkgconfig.cmake'), 'if(MSVC OR IOS OR XROS)\n  return()\n');
    await build(h, 'opencv');
    // Preserve upstream build information and data-search metadata.
    expect(h.read(join(h.src, 'cmake', 'OpenCVUtils.cmake'))).toBe(
      `function(ocv_output_status msg)\n  message(STATUS "\${msg}")\n`,
    );
    expect(h.read(join(h.src, 'modules', 'core', 'CMakeLists.txt'))).toBe(
      `#define OPENCV_INSTALL_PREFIX \\"\${CMAKE_INSTALL_PREFIX}\\"\n#define OPENCV_BUILD_DIR \\"\${CMAKE_BINARY_DIR}\\"\n`,
    );
    // iOS gets engine packaging metadata; upstream intentionally skips its generator.
    expect(h.read(join(h.src, 'cmake', 'OpenCVGenPkgconfig.cmake'))).toBe(
      'if(MSVC OR IOS OR XROS)\n  return()\n',
    );
    const setup = commands(h)[0]!;
    for (const arg of [
      '-DBUILD_LIST=core,imgproc',
      '-DWITH_IPP=OFF',
      '-DWITH_OPENCL=OFF',
      '-DBUILD_ZLIB=OFF',
    ]) {
      expect(setup).toContain(arg);
    }
    expect(setup.includes('-DOPENCV_LIB_INSTALL_PATH=lib')).toBe(android);
    expect(h.read(join(h.src, 'CMakeLists.txt'))).toBe(
      `status("    C++ flags (Release):"    \${CMAKE_CXX_FLAGS} \${CMAKE_CXX_FLAGS_RELEASE})\n` +
        `  status("    Linker flags (Debug):"   \${CMAKE_EXE_LINKER_FLAGS} \${CMAKE_EXE_LINKER_FLAGS_DEBUG})\n` +
        `status("    Version control:" \${OPENCV_VCSVERSION})\n`,
    );
    const win = platform.startsWith('win-') ? ' -lole32' : '';
    const installed = h.read(pcPath(h, 'opencv4'));
    expect(installed).toContain(`Libs: -L\${libdir} -lopencv_imgproc -lopencv_core\n`);
    expect(installed).toContain(
      `Libs.private: ${ios ? '-lz -lm' : '-ldl -lm'} ${cxxRuntime(platform)}${win}\n`,
    );
    expect(installed.includes(`Cflags: -I\${includedir} -I\${includedir}/opencv4\n`)).toBe(ios);
  });
  it('is OpenCV 4 (the C API FFmpeg uses), Apache-2.0', () => {
    expect(recipe('opencv').versions).toEqual({ 'git-tags': '^(4\\.\\d+\\.\\d+)$' });
    expect(recipe('opencv').license).toBe('Apache-2.0');
  });
});
