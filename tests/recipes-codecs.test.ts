// Batch c of #21 (codecs): each library's build on every platform it builds on, with the process runner stubbed, and
// the files it leaves in deps.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { valuesOn } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
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
/** The CFLAGS a recipe's `+= -std=gnu17` makes (appended with a space, even to none), as `commands` shows it. */
const gnu17 = (h: Harness) => ` [CFLAGS=${env(h, 'CFLAGS')} -std=gnu17]`;

// Theora's libraries and headers from git (autogen.sh is autoreconf), against the libogg in deps.
describe('libtheora', () => {
  it.each(platformsOf('libtheora'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libtheora');
    expect(commands(h)).toEqual([
      './autogen.sh',
      configureLine(h, [
        '--disable-shared',
        '--enable-static',
        '--with-pic',
        '--disable-examples',
        '--disable-doc',
        '--disable-spec',
        '--disable-oggtest',
        '--disable-vorbistest',
        '--disable-sdltest',
        `--with-ogg=${h.deps}`,
        // mingw's build of its x86-64 assembly encodes corrupt Theora
        ...(platform === 'win-x64' ? ['--disable-asm'] : []),
      ]),
      'make -j4',
      'make install',
    ]);
  });
  it('needs libogg, and builds everywhere', () => {
    expect(recipe('libtheora').needs).toEqual([{ name: 'libogg' }]);
    expect(platformsOf('libtheora')).toEqual(PLATFORMS);
  });
});

// TwoLAME's library and .pc from the release tarball, with its native static-consumer configuration on Windows.
describe('twolame', () => {
  const header =
    '#  ifdef LIBTWOLAME_STATIC\n#   define TL_API\n#  else\n#   define TL_API __declspec(dllimport)\n';
  it.each(platformsOf('twolame'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.deps, 'include', 'twolame.h'), header);
    put(pcPath(h, 'twolame'), `Libs: -ltwolame\nCflags: -I\${includedir}\n`);
    await build(h, 'twolame');
    expect(commands(h)).toEqual([
      configureLine(h, ['--disable-shared', '--enable-static', '--with-pic', '--disable-sndfile']),
      'make -j4 -C libtwolame',
      'make -C libtwolame install',
      'make install-pkgconfigDATA',
    ]);
    expect(h.read(join(h.deps, 'include', 'twolame.h'))).toBe(header);
    expect(h.read(pcPath(h, 'twolame'))).toContain(
      platform.startsWith('win-')
        ? `Cflags: -I\${includedir} -DLIBTWOLAME_STATIC\n`
        : `Cflags: -I\${includedir}\n`,
    );
  });
  it('builds everywhere', () => {
    expect(platformsOf('twolame')).toEqual(PLATFORMS);
  });
});

// shine's library, header and .pc only (not the shineenc program), as C17, its config.sub refreshed.
describe('shine', () => {
  it.each(platformsOf('shine'))('%s', async (platform) => {
    const h = fake(platform);
    const pkgConfig = join(h.src, 'shine.pc.in');
    put(pkgConfig, `Libs: -L\${libdir} -lm -lshine\n`);
    put(pcPath(h, 'shine'), `Libs: -L\${libdir} -lm -lshine\n`);
    await build(h, 'shine');
    expect(h.read(pkgConfig)).toBe(`Libs: -L\${libdir} -lm -lshine\n`);
    expect(h.read(pcPath(h, 'shine'))).toBe(`Libs: -L\${libdir} -lshine\nLibs.private: -lm\n`);
    expect(commands(h)).toEqual(
      [
        'autoreconf -fi',
        configureLine(h, ['--disable-shared', '--enable-static', '--with-pic']),
        'make -j4 libshine.la',
        'make install-libLTLIBRARIES install-libshine_laHEADERS install-pkgconfigDATA',
      ].map((line) => `${line}${gnu17(h)}`),
    );
  });
});

// liblc3 without its default LTO.
describe('liblc3', () => {
  it.each(platformsOf('liblc3'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'liblc3');
    expect(commands(h)).toEqual(
      mesonLines(h, ['-Db_lto=false', '-Dtools=false', '-Dpython=false']),
    );
  });
});

// codec2's library alone, its codebook generator compiled for the build machine first and handed to the CMake as an
// imported program (its own cross build of the generator inherits the target's compiler).
describe('codec2', () => {
  it.each(platformsOf('codec2'))('%s', async (platform) => {
    const h = fake(platform);
    put(
      join(h.src, 'src', 'CMakeLists.txt'),
      'if(CMAKE_CROSSCOMPILING)\n    set(CMAKE_DISABLE_SOURCE_CHANGES OFF)\n    include(ExternalProject)\n',
    );
    put(
      join(h.src, 'CMakeLists.txt'),
      `if(WIN32)\n    install(SCRIPT \${CMAKE_BINARY_DIR}/cmake/GetDependencies.cmake)\nendif()\n`,
    );
    await build(h, 'codec2');
    const unset = ['CC', 'CFLAGS', 'CPPFLAGS', 'LDFLAGS', 'SDKROOT']
      .filter((k) => h.base[k] !== undefined)
      .map((k) => `-${k}`);
    expect(commands(h)).toEqual([
      `cc -O2 -o generate_codebook_host src/generate_codebook.c -lm${unset.length ? ` [${unset.join(' ')}]` : ''}`,
      [
        'cmake',
        '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
        '-B',
        '_build',
        '-S',
        '.',
        '-DCMAKE_BUILD_TYPE=Release',
        `-DCMAKE_INSTALL_PREFIX=${h.deps}`,
        '-DCMAKE_INSTALL_LIBDIR=lib',
        '-DBUILD_SHARED_LIBS=OFF',
        '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
        '-DUNITTEST=OFF',
        '-DLPCNET=OFF',
        `-DGENERATE_CODEBOOK=${h.src}/generate_codebook_host`,
        ...h.context.toolchain.cmakeArgs,
      ].join(' '),
      'cmake --build _build --target codec2 -j4',
      'cmake --install _build',
    ]);
    expect(h.read(join(h.src, 'src', 'CMakeLists.txt'))).toBe(
      `if(DEFINED GENERATE_CODEBOOK)\n    add_executable(generate_codebook IMPORTED)\n    set_target_properties(generate_codebook PROPERTIES IMPORTED_LOCATION \${GENERATE_CODEBOOK})\nelseif(CMAKE_CROSSCOMPILING)\n    set(CMAKE_DISABLE_SOURCE_CHANGES OFF)\n    include(ExternalProject)\n`,
    );
    expect(h.read(join(h.src, 'CMakeLists.txt'))).toBe('if(WIN32)\n    \nendif()\n');
  });
});

// libilbc with its abseil submodule, the platform's flags kept and its test programs left out; the docs its install
// adds are removed, and the C++ runtime it needs goes on its .pc and, through configure, on FFmpeg's link (FFmpeg
// finds it with a plain -lilbc).
describe('libilbc', () => {
  const runtime = (p: string) => {
    if (/^(osx|ios|maccatalyst|android)-/.test(p)) {
      return '-lc++';
    }
    if (p === 'win-arm64') {
      return '-l:libc++.a';
    }
    return p.startsWith('linux-musl-') ? '-l:libstdc++.a' : '-lstdc++';
  };
  it.each(platformsOf('libilbc'))('%s', async (platform) => {
    const h = fake(platform);
    const cmakeLists = [
      '    set(CMAKE_C_FLAGS "-Wall -Wextra")',
      '    set(CMAKE_CXX_FLAGS "-Wall -Wextra")',
      'add_executable(ilbc_test modules/test.c)',
      'add_executable(ilbc_test2 iLBC_test2.c)',
      'install(TARGETS ilbc ilbc_test',
      '',
    ];
    put(join(h.src, 'CMakeLists.txt'), cmakeLists.join('\n'));
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        put(join(h.deps, 'lib', 'libilbc.a'), '!<arch>\n');
        put(join(h.deps, 'include', 'ilbc.h'), '');
        put(join(h.deps, 'share', 'doc', 'libilbc', 'README.md'), '');
        put(pcPath(h, 'libilbc'), `Name: libilbc\nLibs: -L\${libdir} -lilbc\n`);
      }
      return undefined;
    };
    await build(h, 'libilbc');
    expect(commands(h)).toEqual(cmakeLines(h, []));
    // the platform's flags kept, the test programs neither built nor installed
    expect(h.read(join(h.src, 'CMakeLists.txt'))).toBe(
      [
        `    set(CMAKE_C_FLAGS "\${CMAKE_C_FLAGS} -Wall -Wextra")`,
        `    set(CMAKE_CXX_FLAGS "\${CMAKE_CXX_FLAGS} -Wall -Wextra")`,
        'add_executable(ilbc_test EXCLUDE_FROM_ALL modules/test.c)',
        'add_executable(ilbc_test2 EXCLUDE_FROM_ALL iLBC_test2.c)',
        'install(TARGETS ilbc',
        '',
      ].join('\n'),
    );
    expect(h.files(h.deps)).toEqual([
      'include/ilbc.h',
      'lib/libilbc.a',
      'lib/pkgconfig/libilbc.pc',
    ]);
    expect(h.read(pcPath(h, 'libilbc'))).toBe(
      `Name: libilbc\nLibs: -L\${libdir} -lilbc\nLibs.private: ${runtime(platform)}\n`,
    );
  });
  it('fetches abseil, counts its licence, and puts the C++ runtime on the link', () => {
    const r = recipe('libilbc');
    expect('git' in r.source && r.source.submodules).toMatchObject({ recursive: true });
    expect(r.license).toBe('BSD-3-Clause AND Apache-2.0');
    for (const p of platformsOf('libilbc')) {
      expect(valuesOn(r, 'configure', p), p).toEqual([
        '--enable-libilbc',
        `--extra-libs=${runtime(p)}`,
      ]);
    }
  });
});

// Xvid's own configure in build/generic, only its static archive (mingw's xvidcore.a installed as libxvidcore.a),
// and xvid.h, by hand; C17, with upstream's own configure handling the compiler's supported flags.
describe('xvidcore', () => {
  it.each(platformsOf('xvidcore'))('%s', async (platform) => {
    const h = fake(platform);
    const archive = platform.startsWith('win-') ? 'xvidcore.a' : 'libxvidcore.a';
    put(join(h.src, 'build', 'generic', 'configure'), '\tSPECIFIC_CFLAGS="-mno-cygwin"\n');
    put(join(h.src, 'build', 'generic', '=build', archive), '!<arch>\n');
    put(join(h.src, 'src', 'xvid.h'), '/* xvid */\n');
    put(join(h.src, 'src', 'encoder.c'), 'upstream encoder source\n');
    await build(h, 'xvidcore');
    const host = env(h, 'CROSS_HOST');
    const asm = ['osx-x64', 'maccatalyst-x64', 'android-x64'].includes(platform)
      ? ' --disable-assembly'
      : '';
    expect(commands(h)).toEqual([
      `build/generic$ ./configure --prefix=${h.deps}${host ? ` --host=${host}` : ''}${asm}${gnu17(h)}`,
      `build/generic$ make -j4 ${archive}${gnu17(h)}`,
    ]);
    expect(h.read(join(h.src, 'build', 'generic', 'configure'))).toBe(
      '\tSPECIFIC_CFLAGS="-mno-cygwin"\n',
    );
    expect(h.read(join(h.src, 'src', 'encoder.c'))).toBe('upstream encoder source\n');
    expect(h.files(h.deps)).toEqual(['include/xvid.h', 'lib/libxvidcore.a']);
  });
  it('omits Win-x64 where native configure retains the unsupported -mno-cygwin flag', () => {
    expect(platformsOf('xvidcore')).toEqual(PLATFORMS.filter((p) => p !== 'win-x64'));
  });
});

// VVenC's library alone: no LTO, no -Werror, and Arm SVE off where the C library has no getauxval.
describe('vvenc', () => {
  const sveOff = ['-DVVENC_ENABLE_ARM_SIMD_SVE=OFF', '-DVVENC_ENABLE_ARM_SIMD_SVE2=OFF'];
  it('builds everywhere but linux-armhf', () => {
    expect(platformsOf('vvenc')).toEqual(PLATFORMS.filter((p) => p !== 'linux-armhf'));
  });
  it.each(platformsOf('vvenc'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'vvenc');
    const sve = /^(osx-arm64|ios-|maccatalyst-arm64|win-arm64)/.test(platform) ? sveOff : [];
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DVVENC_LIBRARY_ONLY=ON',
        '-DVVENC_ENABLE_LINK_TIME_OPT=OFF',
        '-DVVENC_ENABLE_WERROR=OFF',
        ...sve,
      ]),
    );
  });
});

// Batch c2: the AVS family, MPEG-5 EVC, APV, JPEG XS and LCEVC.

/** The x264-style configure's cross arguments davs2 and xavs2 take. */
const x264Cross = (platform: string, h: Harness): string[] => {
  if (platform === 'win-x64') {
    return [`--cross-prefix=${env(h, 'CROSS_PREFIX')}-`, '--host=x86_64-w64-mingw32'];
  }
  if (platform.startsWith('android-')) {
    const triple = platform === 'android-arm64' ? 'aarch64-linux-android' : 'x86_64-linux-android';
    return [`--host=${triple}`, `--sysroot=${env(h, 'TOOLCHAIN')}/sysroot`];
  }
  return [];
};
/** davs2 and xavs2: assembly only on glibc x86-64 Linux and Windows (on musl it crashes, on ARM it is missing). */
const asmOff = (platform: string) =>
  /^(linux-x64|win-x64)$/.test(platform) ? [] : ['--disable-asm'];
const AVS2_PLATFORMS = [
  'linux-x64',
  'linux-arm64',
  'linux-musl-x64',
  'linux-musl-arm64',
  'win-x64',
  'android-arm64',
  'android-x64',
];

// davs2's x264-style configure in build/linux, its version and endianness probe made to work in a shallow clone
// with today's compilers, and the C++ runtime its .pc leaves out.
describe('davs2', () => {
  it('builds where its x86-64 assembly or plain C builds', () => {
    expect(platformsOf('davs2')).toEqual(AVS2_PLATFORMS);
  });
  it.each(platformsOf('davs2'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'version.sh'), '    VER_R=`git rev-list --count origin/master`\n');
    const stackProbe =
      "if cc_check '' -mpreferred-stack-boundary=5 ; then\n" +
      '        CFLAGS="$CFLAGS -mpreferred-stack-boundary=5"\n' +
      '        stack_alignment=32\n';
    put(
      join(h.src, 'build', 'linux', 'configure'),
      `    elif !(strings | grep -q EGIB) ; then\n${stackProbe}`,
    );
    put(pcPath(h, 'davs2'), `Name: davs2\nLibs: -L\${libdir} -ldavs2\n`);
    await build(h, 'davs2');
    // its sources are C++: CC is the platform's C++ compiler
    const cxx = ` [CC=${env(h, 'CXX') || 'g++'}]`;
    expect(commands(h)).toEqual([
      [
        `build/linux$ ./configure --prefix=${h.deps}`,
        '--disable-cli',
        '--enable-pic',
        ...x264Cross(platform, h),
        ...asmOff(platform),
      ].join(' ') + cxx,
      `build/linux$ make -j4 lib-static${cxx}`,
      `build/linux$ make install-lib-static${cxx}`,
    ]);
    expect(h.read(join(h.src, 'version.sh'))).toBe('    VER_R=0\n');
    const expectedStack =
      platform === 'linux-x64'
        ? stackProbe.replaceAll('boundary=5', 'boundary=4').replace('alignment=32', 'alignment=16')
        : stackProbe;
    expect(h.read(join(h.src, 'build', 'linux', 'configure'))).toBe(
      `    elif false && !(strings | grep -q EGIB) ; then\n${expectedStack}`,
    );
    expect(h.read(pcPath(h, 'davs2'))).toMatch(/\nLibs\.private: -l\S+\n$/);
  });
});

// xavs2: as davs2, and its 2019 C made to compile with GCC 14 and nasm 2.16.
describe('xavs2', () => {
  it('builds where davs2 does, but Android (no pthread_setaffinity_np)', () => {
    expect(platformsOf('xavs2')).toEqual(AVS2_PLATFORMS.filter((p) => !p.startsWith('android-')));
  });
  it.each(platformsOf('xavs2'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'version.sh'), '    VER_R=`git rev-list --count origin/master`\n');
    put(
      join(h.src, 'build', 'linux', 'configure'),
      '    elif !(strings | grep -q EGIB) ; then\n' +
        "if cc_check '' -mpreferred-stack-boundary=5 ; then\n" +
        '        CFLAGS="$CFLAGS -mpreferred-stack-boundary=5"\n' +
        '        stack_alignment=32\n',
    );
    await build(h, 'xavs2');
    expect(commands(h)).toEqual([
      [
        `build/linux$ ./configure --prefix=${h.deps}`,
        '--disable-cli',
        '--enable-static',
        '--enable-pic',
        ...x264Cross(platform, h),
        '--extra-cflags=-Wno-error=incompatible-pointer-types -std=gnu17',
        '--extra-asflags=-w-macro-params-legacy',
        ...asmOff(platform),
      ].join(' '),
      'build/linux$ make -j4 lib-static',
      'build/linux$ make install-lib-static',
    ]);
    expect(h.read(join(h.src, 'version.sh'))).toBe('    VER_R=0\n');
    const configure = h.read(join(h.src, 'build', 'linux', 'configure'));
    expect(configure).toContain(
      platform === 'linux-x64' ? 'stack_alignment=16' : 'stack_alignment=32',
    );
  });
});

// xavs (AVS1) from the git-svn mirror of its last revision: plain C, the archive and header by hand.
describe('xavs', () => {
  it('builds for x86-64 Linux and Windows', () => {
    expect(platformsOf('xavs')).toEqual(['linux-x64', 'linux-musl-x64', 'win-x64']);
  });
  it.each(platformsOf('xavs'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'configure'), '    DEVNULL="NUL"\n');
    put(join(h.src, 'libxavs.a'), '!<arch>\n');
    put(join(h.src, 'xavs.h'), '/* xavs */\n');
    await build(h, 'xavs');
    const cross =
      platform === 'win-x64'
        ? ` --host=x86_64-w64-mingw32 --cross-prefix=${env(h, 'CROSS_PREFIX')}-`
        : '';
    expect(commands(h)).toEqual([
      `./configure --prefix=${h.deps} --disable-asm --enable-pic${cross}`,
      'make -j4 libxavs.a',
    ]);
    expect(h.read(join(h.src, 'configure'))).toBe('    DEVNULL="/dev/null"\n');
    expect(h.files(h.deps)).toEqual(['include/xavs.h', 'lib/libxavs.a']);
  });
  it('follows the mirror of r55, and ships its GPL notice', () => {
    const r = recipe('xavs');
    expect(r.versions).toEqual({ 'git-branch': 'trunk' });
    expect(r['license-files']).toEqual([{ path: 'xavs.h' }]);
  });
});

// uavs3d: CMake, 10-bit (which decodes 8-bit too).
describe('uavs3d', () => {
  it('builds everywhere but win-arm64', () => {
    expect(platformsOf('uavs3d')).toEqual(PLATFORMS.filter((p) => p !== 'win-arm64'));
  });
  it.each(platformsOf('uavs3d'))('%s', async (platform) => {
    const h = fake(platform);
    const cmake = join(h.src, 'source', 'CMakeLists.txt');
    put(cmake, 'if(CMAKE_USE_PTHREADS_INIT)\nif(CMAKE_USE_PTHREADS_INIT)\n');
    put(join(h.src, 'CMakeLists.txt'), `add_executable(uavs3dec \${DIR_SRC_TEST})\n`);
    put(
      join(h.src, 'source', 'decoder', 'uavs3d.c'),
      'printf("libuavs3d(%2d): %s_%s, %s\\n", BIT_DEPTH, VERSION_STR, VERSION_TYPE, VERSION_SHA1);\n',
    );
    await build(h, 'uavs3d');
    expect(commands(h)).toEqual(
      cmakeLines(h, ['-DCOMPILE_10BIT=1']).map((line) =>
        line === 'cmake --build _build -j4' ? `${line} --target uavs3d` : line,
      ),
    );
    // its decoder program is left out of the build
    expect(h.read(join(h.src, 'CMakeLists.txt'))).toBe(
      `add_executable(uavs3dec \${DIR_SRC_TEST})\n`,
    );
    // Android has no libpthread to link: neither the library nor its .pc names it there
    expect(h.read(cmake)).toBe(
      platform.startsWith('android-')
        ? 'if(FALSE)\nif(FALSE)\n'
        : 'if(CMAKE_USE_PTHREADS_INIT)\nif(CMAKE_USE_PTHREADS_INIT)\n',
    );
  });
});

// XEVE and XEVD: native Release flags, library targets and install components; static archive moved out of lib/<name>/,
// the .pc's extra -L dropped.
describe.each(['xeve', 'xevd'])('%s', (name) => {
  it('builds everywhere but linux-armhf', () => {
    expect(platformsOf(name)).toEqual(PLATFORMS.filter((p) => p !== 'linux-armhf'));
  });
  it.each(platformsOf(name))('%s', async (platform) => {
    const h = fake(platform);
    put(
      join(h.src, 'CMakeLists.txt'),
      `set (CMAKE_C_FLAGS "\${CMAKE_C_FLAGS} -Wall -Werror -Wno-pointer-sign")\nadd_subdirectory(app)\n`,
    );
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        put(join(h.deps, 'lib', name, `lib${name}.a`), '!<arch>\n');
        put(join(h.deps, 'lib', `lib${name}.so.0.7`), '');
        put(join(h.deps, 'lib', `lib${name}.so`), '');
        put(join(h.deps, 'include', name, `${name}.h`), '');
        put(
          pcPath(h, name),
          `Libs: -L\${libdir} -l${name}\nLibs.private: -L\${libdir}/${name} -lm\n`,
        );
      }
      return undefined;
    };
    await build(h, name);
    const configure = cmakeLines(h, [
      '-DSET_PROF=MAIN',
      '-DCMAKE_C_FLAGS_RELEASE=-O3 -DNDEBUG -Wno-error',
      '-DCMAKE_MACOSX_BUNDLE=OFF',
    ])[0]!;
    expect(commands(h)).toEqual([
      configure,
      `cmake --build _build -j4 --target ${name} ${name}_dynamic`,
      'cmake --install _build --component Libraries',
      'cmake --install _build --component Development',
    ]);
    expect(h.read(join(h.src, 'CMakeLists.txt'))).toBe(
      `set (CMAKE_C_FLAGS "\${CMAKE_C_FLAGS} -Wall -Werror -Wno-pointer-sign")\nadd_subdirectory(app)\n`,
    );
    expect(h.files(h.deps)).toEqual([
      `include/${name}/${name}.h`,
      `lib/lib${name}.a`,
      `lib/pkgconfig/${name}.pc`,
    ]);
    expect(h.read(pcPath(h, name))).toBe(`Libs: -L\${libdir} -l${name}\nLibs.private: -lm\n`);
  });
});

// OpenAPV's static library alone, at 0.x (FFmpeg 9.0's encoder calls 0.x's oapvm_create).
describe('oapv', () => {
  it.each(platformsOf('oapv'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'src', 'neon', 'oapv_sad_neon.c'), 'int sad_16b_neon_8x2n(void);\n');
    await build(h, 'oapv');
    expect(commands(h)).toEqual(
      cmakeLines(h, ['-DOAPV_BUILD_SHARED_LIB=OFF', '-DOAPV_BUILD_APPS=OFF', '-DENABLE_TESTS=OFF']),
    );
    // XEVE defines the same NEON helper: renamed, so both link together
    expect(h.read(join(h.src, 'src', 'neon', 'oapv_sad_neon.c'))).toBe(
      'int oapv_sad_16b_neon_8x2n(void);\n',
    );
  });
  it('takes 0.x releases only', () => {
    const r = recipe('oapv');
    expect(r.versions).toEqual({ 'git-tags': String.raw`^v(0\.\d+\.\d+\.\d+)$` });
    expect(platformsOf('oapv')).toEqual(PLATFORMS.filter((p) => p !== 'linux-armhf'));
  });
});

// SVT-JPEG-XS from main (0.10.0 has no tag yet), without LTO.
describe('svt-jpegxs', () => {
  it.each(platformsOf('svt-jpegxs'))('%s', async (platform) => {
    const h = fake(platform);
    const clang = 'if(CMAKE_C_COMPILER_ID MATCHES "Clang" AND UNIX AND NOT APPLE)\n';
    put(join(h.src, 'CMakeLists.txt'), clang);
    put(pcPath(h, 'SvtJpegxs'), `Libs: -L\${libdir} -lSvtJpegxs\nLibs.private: -lpthread -lm\n`);
    await build(h, 'svt-jpegxs');
    // Android has no libpthread to link
    expect(h.read(pcPath(h, 'SvtJpegxs'))).toBe(
      `Libs: -L\${libdir} -lSvtJpegxs\nLibs.private: ${platform.startsWith('android-') ? '' : '-lpthread '}-lm\n`,
    );
    expect(commands(h)).toEqual(
      cmakeLines(h, ['-DBUILD_APPS=OFF', '-DBUILD_TESTING=OFF', '-DJPEGXS_LTO=OFF']).map((line) =>
        platform.startsWith('android-')
          ? `${line} [PATH=${env(h, 'TOOLCHAIN')}/bin:${env(h, 'PATH')}]`
          : line,
      ),
    );
    expect(h.read(join(h.src, 'CMakeLists.txt'))).toBe(clang);
  });
  it('follows main, on every platform', () => {
    expect(recipe('svt-jpegxs').versions).toEqual({ 'git-branch': 'main' });
    expect(platformsOf('svt-jpegxs')).toEqual(PLATFORMS);
  });
});

// LCEVCdec's decoder libraries; its .pc's C++ runtime and libm moved after its libraries, the licence folder it
// installs removed.
describe('lcevcdec', () => {
  it.each(platformsOf('lcevcdec'))('%s', async (platform) => {
    const h = fake(platform);
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        put(join(h.deps, 'licenses', 'COPYING'), '');
        put(
          pcPath(h, 'lcevc_dec'),
          `Libs: -L"\${libdir}" -lstdc++ -lm -llcevc_dec_api -llcevc_dec_common\n`,
        );
      }
      return undefined;
    };
    await build(h, 'lcevcdec');
    expect(h.files(h.src)).toEqual([]);
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DVN_SDK_EXECUTABLES=OFF',
        '-DVN_SDK_SAMPLE_SOURCE=OFF',
        '-DVN_SDK_UNIT_TESTS=OFF',
        '-DVN_SDK_DOCS=OFF',
        '-DVN_SDK_PIPELINE_VULKAN=OFF',
        '-DVN_SDK_JSON_CONFIG=OFF',
        '-DVN_SDK_TRACING=OFF',
        '-DVN_SDK_METRICS=OFF',
        '-DVN_SDK_SYSTEM_INSTALL=OFF',
        '-DVN_SDK_BUILD_DETAILS=OFF',
      ]),
    );
    expect(existsSync(join(h.deps, 'licenses'))).toBe(false);
    // Android's surfaces: libandroid and libnativewindow
    const android = platform.startsWith('android-') ? ' -landroid -lnativewindow' : '';
    const threads = platform.startsWith('linux-') ? String.raw`Libs\.private: -pthread\n` : '';
    expect(h.read(pcPath(h, 'lcevc_dec'))).toMatch(
      new RegExp(
        String.raw`^Libs: -L"\$\{libdir\}" -llcevc_dec_api -llcevc_dec_common -l\S+ -lm${android}\n${threads}$`,
      ),
    );
  });
  it('excludes Windows until the toolchain and source support native unpatched builds', () => {
    expect(platformsOf('lcevcdec')).toEqual(PLATFORMS.filter((p) => !p.startsWith('win-')));
  });
  it('is under its own licence terms, kept out of GPL builds', () => {
    expect(recipe('lcevcdec').license).toBe('LicenseRef-LCEVCdec');
    expect(recipe('lcevcdec')['license-files']).toEqual([
      { path: 'LICENSE.md' },
      { path: 'COPYING' },
    ]);
  });
});

// Batch c3: game and tracker module music.

/** The C++ runtime a static link needs, as the engine's {cxx-runtime} names it. */
const cxxRuntime = (platform: string) => {
  if (/^(osx|ios|maccatalyst|android)-/.test(platform)) {
    return '-lc++';
  }
  if (platform === 'win-arm64') {
    return '-l:libc++.a';
  }
  return platform.startsWith('linux-musl-') ? '-l:libstdc++.a' : '-lstdc++';
};

// Game_Music_Emu's static library alone, without zlib; its .pc's Libs.private (the compiler's implicit link line)
// becomes the platform's C++ runtime and libm.
describe('libgme', () => {
  it.each(platformsOf('libgme'))('%s', async (platform) => {
    const h = fake(platform);
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        put(
          pcPath(h, 'libgme'),
          `Libs: -L\${libdir} -lgme\nLibs.private: -lstdc++ -lm -lgcc_s -lgcc -lc -lgcc_s -lgcc\n`,
        );
      }
      return undefined;
    };
    await build(h, 'libgme');
    // musl's headers don't bring in <ctime> by the way, as glibc's do
    const musl = platform.startsWith('linux-musl-')
      ? ` [CXXFLAGS=${env(h, 'CXXFLAGS')} -include ctime]`
      : '';
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DGME_BUILD_SHARED=OFF',
        '-DGME_BUILD_STATIC=ON',
        '-DGME_BUILD_EXAMPLES=OFF',
        '-DGME_BUILD_TESTING=OFF',
        '-DGME_ENABLE_UBSAN=OFF',
        '-DGME_ZLIB=OFF',
        '-DGME_BUILD_FRAMEWORK=OFF',
      ]).map((line) => line + musl),
    );
    expect(h.read(pcPath(h, 'libgme'))).toBe(
      `Libs: -L\${libdir} -lgme\nLibs.private: ${cxxRuntime(platform)} -lm\n`,
    );
  });
});

// libmodplug from its last release tarball, as C++14; its .pc's -lstdc++ the platform's runtime, and on Windows the
// define that makes modplug.h declare the static library's symbols.
describe('libmodplug', () => {
  it.each(platformsOf('libmodplug'))('%s', async (platform) => {
    const h = fake(platform);
    put(
      pcPath(h, 'libmodplug'),
      `Libs: -L\${libdir} -lmodplug\nLibs.private: -lstdc++ -lm\nCflags: -I\${includedir}\n`,
    );
    await build(h, 'libmodplug');
    const cxxflags = ` [CXXFLAGS=${env(h, 'CXXFLAGS')} -std=gnu++14]`;
    expect(commands(h)).toEqual(
      [
        'autoreconf -fi',
        configureLine(h, ['--disable-shared', '--enable-static', '--with-pic']),
        'make -j4',
        'make install',
      ].map((line) => `${line}${cxxflags}`),
    );
    const win = platform.startsWith('win-') ? ' -DMODPLUG_STATIC' : '';
    expect(h.read(pcPath(h, 'libmodplug'))).toBe(
      `Libs: -L\${libdir} -lmodplug\nLibs.private: ${cxxRuntime(platform)} -lm\nCflags: -I\${includedir}${win}\n`,
    );
  });
  it('is public domain, allowed in every build', () => {
    expect(recipe('libmodplug').license).toBe('LicenseRef-libmodplug-public-domain');
  });
});

// libopenmpt's autotools tarball: the library alone, none of its optional libraries, and the platform's C++ runtime
// for its .pc.
describe('libopenmpt', () => {
  it.each(platformsOf('libopenmpt'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libopenmpt');
    // win32-thread GCC 13 has std::mutex only when targeting Vista or later
    const vista =
      platform === 'win-x64' ? ` [CPPFLAGS=${env(h, 'CPPFLAGS')} -D_WIN32_WINNT=0x0601]` : '';
    expect(commands(h)).toEqual(
      [
        configureLine(h, [
          '--disable-shared',
          '--enable-static',
          '--with-pic',
          '--disable-openmpt123',
          '--disable-examples',
          '--disable-tests',
          '--disable-doxygen-doc',
          '--without-zlib',
          '--without-mpg123',
          '--without-ogg',
          '--without-vorbis',
          '--without-vorbisfile',
          '--without-pulseaudio',
          '--without-portaudio',
          '--without-portaudiocpp',
          '--without-sdl2',
          '--without-sndfile',
          '--without-flac',
          `CXXSTDLIB_PCLIBSPRIVATE=${cxxRuntime(platform)} -lm`,
        ]),
        'make -j4',
        'make install',
      ].map((line) => line + vista),
    );
  });
});

// rav1e: cargo-c's static library for the platform's Rust target. The images carry Rust and cargo-c; on Apple,
// Homebrew's rustup puts them in the build's own folder first.
describe('rav1e', () => {
  const RUST_TARGET: Record<string, string> = {
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'linux-armhf': 'armv7-unknown-linux-gnueabihf',
    'linux-musl-x64': 'x86_64-unknown-linux-musl',
    'linux-musl-arm64': 'aarch64-unknown-linux-musl',
    'win-x64': 'x86_64-pc-windows-gnu',
    'win-arm64': 'aarch64-pc-windows-gnullvm',
    'osx-arm64': 'aarch64-apple-darwin',
    'osx-x64': 'x86_64-apple-darwin',
    'ios-arm64': 'aarch64-apple-ios',
    'ios-sim-arm64': 'aarch64-apple-ios-sim',
    'maccatalyst-arm64': 'aarch64-apple-ios-macabi',
    'maccatalyst-x64': 'x86_64-apple-ios-macabi',
    'android-arm64': 'aarch64-linux-android',
    'android-x64': 'x86_64-linux-android',
  };
  it('builds everywhere', () => {
    expect(platformsOf('rav1e')).toEqual(PLATFORMS);
    expect(Object.keys(RUST_TARGET).sort()).toEqual([...PLATFORMS].sort());
  });
  it.each(platformsOf('rav1e'))('%s', async (platform) => {
    const h = fake(platform);
    put(pcPath(h, 'rav1e'), `Libs: -L\${libdir} -lrav1e\nLibs.private: -lunwind -lc\n`);
    fakeCargo(h, { name: 'rav1e', version: '0.8.1', license: 'BSD-2-Clause' }, [
      { name: 'libc', version: '0.2.172', license: 'MIT OR Apache-2.0', files: { LICENSE: 'mit' } },
      { name: 'av-metrics', version: '0.9.1', license: 'MIT' },
    ]);
    await build(h, 'rav1e');
    const target = RUST_TARGET[platform]!;
    const apple = /^(osx|ios|maccatalyst)-/.test(platform);
    const all = h.calls.map((c) => [c.command, ...c.args].join(' '));
    // its crates, listed for the platform's Rust target once Rust is there, then the build offline
    const fetch = all.indexOf('cargo fetch --locked');
    expect(all.slice(fetch + 1, fetch + 3).map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
      'cargo metadata',
      'cargo tree',
    ]);
    expect(all[fetch + 2]).toContain(`-p rav1e -F capi --target ${target}`);
    expect(h.calls.at(-1)!.env['CARGO_NET_OFFLINE']).toBe('true');
    const calls = all.filter((c) => !/^(rustc|cargo (fetch|metadata|tree))( |$)/.test(c));
    expect(calls.at(-1)).toBe(
      `cargo cinstall --release --locked --library-type=staticlib --target=${target} --prefix=${h.deps} --libdir=${h.deps}/lib --includedir=${h.deps}/include`,
    );
    // build scripts run here: compiled with this machine's compilers
    const last = h.calls.at(-1)!;
    expect(last.env).toMatchObject({
      HOST_CC: 'cc',
      HOST_CXX: 'c++',
      HOST_CFLAGS: '-O2',
      // no build folder in the library's panic messages
      RUSTFLAGS: `--remap-path-prefix=${h.src}=/work/src/rav1e --remap-path-prefix=/opt/cargo=/cargo`,
    });
    // Apple: Rust and cargo-c into the build's folder first (cargo-c built for the Mac, without the platform's flags)
    expect(calls.slice(0, -1)).toEqual(
      apple
        ? [
            `rustup toolchain install 1.98.1 --profile minimal --target ${target}`,
            'cargo install --locked cargo-c@0.10.26',
          ]
        : [],
    );
    expect(last.env['CARGO_HOME']).toBe(apple ? `${h.src}/_cargo` : undefined);
    // Apple: the platform's flags reach the target's compiles only, not the build scripts compiled for the Mac
    const crossApple = apple && platform !== 'osx-arm64';
    expect(last.env[`CFLAGS_${target.replaceAll('-', '_')}`]).toBe(
      crossApple ? h.context.env['EXTRA_CFLAGS'] : undefined,
    );
    expect('CFLAGS' in last.env && last.env['CFLAGS'] === null).toBe(
      apple && h.base['CFLAGS'] !== undefined,
    );
    expect(apple ? h.calls[1]!.env : { CC: null, CFLAGS: null }).toMatchObject({
      CC: null,
      CFLAGS: null,
    });
    const cross = ['linux-armhf', 'win-x64', 'win-arm64', 'android-arm64', 'android-x64'];
    const key = target.replaceAll('-', '_');
    expect(last.env[`CC_${key}`] !== undefined).toBe(cross.includes(platform));
    expect(last.env[`CARGO_TARGET_${key.toUpperCase()}_LINKER`] !== undefined).toBe(
      cross.includes(platform),
    );
  });
  it("swaps Rust's libunwind for GCC's unwinder on musl", async () => {
    const h = fake('linux-musl-x64');
    const pc = `Libs: -L\${libdir} -lrav1e -lunwind -lc\nLibs.private: -lunwind -lc -lunwind -lc\n`;
    put(pcPath(h, 'rav1e'), pc);
    fakeCargo(h, { name: 'rav1e', version: '0.8.1', license: 'BSD-2-Clause' }, []);
    await build(h, 'rav1e');
    expect(h.read(pcPath(h, 'rav1e'))).toBe(
      `Libs: -L\${libdir} -lrav1e -lc\nLibs.private: -lgcc_eh -lc\n`,
    );
  });
});

// The toolchain images rav1e builds in carry the same pinned Rust and cargo-c, with the standard library of every
// Rust target the image's platforms need.
describe('Rust in the toolchain images', () => {
  const images: Record<string, string[]> = {
    'linux-x64': [],
    'linux-arm64': [],
    'linux-musl-x64': [],
    'linux-musl-arm64': [],
    'cross-windows': ['x86_64-pc-windows-gnu', 'aarch64-pc-windows-gnullvm'],
    'cross-armhf': ['armv7-unknown-linux-gnueabihf'],
    'cross-android': ['aarch64-linux-android', 'x86_64-linux-android'],
  };
  it.each(Object.keys(images))('%s', (image) => {
    const text = readFileSync(join(packageRoot, 'images', image, 'Dockerfile'), 'utf8');
    expect(text).toContain(
      `ENV RUSTUP_HOME=/opt/rust CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:\${PATH}`,
    );
    expect(text).toMatch(
      /rustup-init -y --no-modify-path --profile minimal --default-toolchain 1\.98\.1/,
    );
    for (const target of images[image]!) {
      expect(text).toContain(`--target ${target}`);
    }
    expect(text).toMatch(
      /cargo-c\/releases\/download\/v0\.10\.26\/cargo-c-(x86_64|aarch64)-unknown-linux-musl/,
    );
    expect(text).toContain('cargo cinstall --version');
  });
  it("Apple's Homebrew tools include rustup", () => {
    const brew = readFileSync(join(packageRoot, 'platforms', 'apple-brew.txt'), 'utf8');
    expect(brew.split('\n')).toContain('rustup');
  });
});
