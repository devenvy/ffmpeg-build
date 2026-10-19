// Batch c of #21 (codecs): each library's build on every platform it builds on, with the process runner stubbed, and
// the files it leaves in deps.
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
import { valuesOn } from '../src/engine-data.ts';
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

// TwoLAME's library and .pc from the release tarball; on Windows its header loses the dllimport that FFmpeg's plain
// `-ltwolame` link can't satisfy.
describe('twolame', () => {
  const header =
    '#  ifdef LIBTWOLAME_STATIC\n#   define TL_API\n#  else\n#   define TL_API __declspec(dllimport)\n';
  it.each(platformsOf('twolame'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.deps, 'include', 'twolame.h'), header);
    await build(h, 'twolame');
    expect(commands(h)).toEqual([
      configureLine(h, ['--disable-shared', '--enable-static', '--with-pic', '--disable-sndfile']),
      'make -j4 -C libtwolame',
      'make -C libtwolame install',
      'make install-pkgconfigDATA',
    ]);
    expect(h.read(join(h.deps, 'include', 'twolame.h'))).toBe(
      platform.startsWith('win-') ? header.replace('__declspec(dllimport)', '') : header,
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
    await build(h, 'shine');
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
// and xvid.h, by hand; C17, and mingw's configure without -mno-cygwin.
describe('xvidcore', () => {
  it.each(platformsOf('xvidcore'))('%s', async (platform) => {
    const h = fake(platform);
    const archive = platform.startsWith('win-') ? 'xvidcore.a' : 'libxvidcore.a';
    put(join(h.src, 'build', 'generic', 'configure'), '\tSPECIFIC_CFLAGS="-mno-cygwin"\n');
    put(join(h.src, 'build', 'generic', '=build', archive), '!<arch>\n');
    put(join(h.src, 'src', 'xvid.h'), '/* xvid */\n');
    await build(h, 'xvidcore');
    const host = env(h, 'CROSS_HOST');
    const asm = ['osx-x64', 'maccatalyst-x64', 'android-x64'].includes(platform)
      ? ' --disable-assembly'
      : '';
    expect(commands(h)).toEqual([
      `build/generic$ ./configure --prefix=${h.deps}${host ? ` --host=${host}` : ''}${asm}${gnu17(h)}`,
      `build/generic$ make -j4 ${archive}${gnu17(h)}`,
    ]);
    expect(h.read(join(h.src, 'build', 'generic', 'configure'))).toBe('\tSPECIFIC_CFLAGS=""\n');
    expect(h.files(h.deps)).toEqual(['include/xvid.h', 'lib/libxvidcore.a']);
  });
  it('builds everywhere', () => {
    expect(platformsOf('xvidcore')).toEqual(PLATFORMS);
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
