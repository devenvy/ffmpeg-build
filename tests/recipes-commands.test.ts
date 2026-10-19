// Recipes whose bash was a command sequence of their own (a configure that isn't autotools', a cmake line of their
// own, a hand-written install). Each test runs the recipe on every platform it builds on and compares the commands,
// their environment and the files with what the old `shell:` step did, as read from it (quoted in the comments).
// The old steps ran `cmake` through a helper that added -DCMAKE_POLICY_VERSION_MINIMUM=3.5 first to every cmake call
// but --build and --install.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { submoduleArgs } from '../src/build/fetch.ts';
import { valuesOn } from '../src/engine-data.ts';

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
function fake(platform: string, options: Parameters<typeof harness>[1] = {}): Harness {
  const h = harness(platform, options);
  made.push(h);
  return h;
}
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const cross = (h: Harness) => h.context.toolchain.cmakeArgs;
const env = (h: Harness, name: string) => h.context.env[name] ?? '';

describe('zlib', () => {
  // if [ -n "${CROSS_HOST:-}" ]; then CHOST="${CROSS_HOST}" ./configure --prefix=... --static; else ./configure ...; fi
  it.each(platformsOf('zlib'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'zlib');
    const host = env(h, 'CROSS_HOST');
    expect(commands(h)).toEqual([
      `./configure --prefix=${h.deps} --static${host ? ` [CHOST=${host}]` : ''}`,
      'make -j4',
      'make install',
    ]);
  });
});

// bzip2 1.0.x has a Makefile of its own (no configure; the CMake/Meson builds are 1.1's, unreleased): only its static
// library, with the platform's tools as make variables (it reads none from the environment), then the library and its
// header copied by hand. No .pc: FFmpeg finds it with check_lib -lbz2.
describe('bzip2', () => {
  it.each(platformsOf('bzip2'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'libbz2.a'), '!<arch>\n');
    put(join(h.src, 'bzlib.h'), '/* bzlib */\n');
    await build(h, 'bzip2');
    const host = env(h, 'CROSS_HOST');
    const tool = (name: string, fallback: string) =>
      env(h, name) || `${host ? `${host}-` : ''}${fallback}`;
    expect(h.calls.map((c) => [c.command, ...c.args])).toEqual([
      [
        'make',
        '-j4',
        'libbz2.a',
        `CC=${tool('CC', 'gcc')}`,
        `AR=${tool('AR', 'ar')}`,
        `RANLIB=${tool('RANLIB', 'ranlib')}`,
        `CFLAGS=-fPIC -O2 -D_FILE_OFFSET_BITS=64 ${env(h, 'EXTRA_CFLAGS')}`,
      ],
    ]);
    expect(h.files(h.deps)).toEqual(['include/bzlib.h', 'lib/libbz2.a']);
    expect(h.read(join(h.deps, 'include', 'bzlib.h'))).toBe('/* bzlib */\n');
  });
  it('builds for the armhf triple, which sets no CC', async () => {
    const h = fake('linux-armhf');
    put(join(h.src, 'libbz2.a'), '');
    put(join(h.src, 'bzlib.h'), '');
    await build(h, 'bzip2');
    expect(h.calls[0]!.args.slice(2, 5)).toEqual([
      'CC=arm-linux-gnueabihf-gcc',
      'AR=arm-linux-gnueabihf-ar',
      'RANLIB=arm-linux-gnueabihf-ranlib',
    ]);
  });
});

// GNU libiconv, where the C library has no iconv FFmpeg can link (Windows; Apple's is a library of its own): only the
// library (libcharset first, which lib/ compiles in), never the GPL iconv program, and the header by hand (top-level
// install-lib would build everything first).
describe('libiconv', () => {
  it.each(platformsOf('libiconv'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'include', 'iconv.h.inst'), '/* iconv */\n');
    await build(h, 'libiconv');
    expect(commands(h)).toEqual([
      configureLine(h, [
        `--libdir=${h.deps}/lib`,
        '--disable-shared',
        '--enable-static',
        '--with-pic',
        '--disable-nls',
      ]),
      'make lib/localcharset.h',
      'make -C lib -j4',
      `make -C lib install-lib libdir=${h.deps}/lib`,
    ]);
    expect(h.files(h.deps)).toEqual(['include/iconv.h']);
    expect(h.read(join(h.deps, 'include', 'iconv.h'))).toBe('/* iconv */\n');
  });
  it('builds where the C library has no iconv FFmpeg links by itself', () => {
    expect(platformsOf('libiconv')).toEqual([
      'win-x64',
      'win-arm64',
      'osx-x64',
      'osx-arm64',
      'ios-arm64',
      'ios-sim-arm64',
      'maccatalyst-x64',
      'maccatalyst-arm64',
    ]);
  });
});

// xz's liblzma alone: the command-line tools, translations, docs and tests off.
describe('xz', () => {
  it.each(platformsOf('xz'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'xz');
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DXZ_NLS=OFF',
        '-DXZ_TOOL_XZ=OFF',
        '-DXZ_TOOL_XZDEC=OFF',
        '-DXZ_TOOL_LZMADEC=OFF',
        '-DXZ_TOOL_LZMAINFO=OFF',
        '-DXZ_TOOL_SCRIPTS=OFF',
        '-DXZ_DOC=OFF',
        '-DBUILD_TESTING=OFF',
      ]),
    );
  });
});

describe('x264', () => {
  // X264_ARGS=(--prefix --enable-static --disable-shared --enable-pic --disable-cli) + the case on BUILD_RID
  const extra = (h: Harness): string[] => {
    const mcat = `-target ${env(h, 'MCAT_TARGET')} -isysroot ${env(h, 'MCAT_SYSROOT')}`;
    const ios = `-arch arm64 ${env(h, 'IOS_MINVER')} -isysroot ${env(h, 'IOS_SYSROOT')}`;
    switch (h.platform) {
      case 'linux-armhf':
        return ['--cross-prefix=arm-linux-gnueabihf-', '--host=arm-linux-gnueabihf'];
      case 'win-x64':
        return [`--cross-prefix=${env(h, 'CROSS_PREFIX')}-`, '--host=x86_64-w64-mingw32'];
      case 'win-arm64':
        return [`--cross-prefix=${env(h, 'CROSS_PREFIX')}-`, '--host=aarch64-w64-mingw32'];
      case 'android-arm64':
        return ['--host=aarch64-linux-android', `--sysroot=${env(h, 'TOOLCHAIN')}/sysroot`];
      case 'android-x64':
        return ['--host=x86_64-linux-android', `--sysroot=${env(h, 'TOOLCHAIN')}/sysroot`];
      case 'maccatalyst-arm64':
        return [
          `--host=${env(h, 'CROSS_HOST')}`,
          `--extra-cflags=${mcat}`,
          `--extra-asflags=${mcat}`,
          `--extra-ldflags=${mcat}`,
        ];
      case 'maccatalyst-x64':
        return [
          `--host=${env(h, 'CROSS_HOST')}`,
          `--extra-cflags=${mcat}`,
          `--extra-ldflags=${mcat}`,
        ];
      case 'osx-x64':
        return [
          `--host=${env(h, 'CROSS_HOST')}`,
          '--extra-cflags=-arch x86_64',
          '--extra-ldflags=-arch x86_64',
        ];
      case 'ios-arm64':
        return [
          '--host=aarch64-apple-darwin',
          `--extra-cflags=${ios}`,
          `--extra-asflags=${ios}`,
          `--extra-ldflags=${ios}`,
        ];
      default:
        return [];
    }
  };
  it.each(platformsOf('x264'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'x264');
    expect(h.calls[0]!.args).toEqual([
      `--prefix=${h.deps}`,
      '--enable-static',
      '--disable-shared',
      '--enable-pic',
      '--disable-cli',
      ...extra(h),
    ]);
    expect(commands(h).slice(1)).toEqual(['make -j4', 'make install']);
    expect(h.calls[0]!.env).toEqual({});
  });
});

describe('libvpx', () => {
  // VPX_ARGS + the case; with VPX_CROSS set, CROSS="${VPX_CROSS}" on configure, make and make install
  const extra = (h: Harness): [string[], string] => {
    const p = env(h, 'CROSS_PREFIX');
    switch (h.platform) {
      case 'linux-armhf':
        return [['--target=armv7-linux-gcc', '--extra-cflags=-mfpu=neon'], 'arm-linux-gnueabihf-'];
      case 'win-x64':
        return [['--target=x86_64-win64-gcc', '--extra-cflags=-static-libgcc'], `${p}-`];
      case 'win-arm64':
        return [['--target=arm64-win64-gcc'], `${p}-`];
      case 'android-arm64':
        return [['--target=arm64-android-gcc', '--extra-cflags=-fPIC'], ''];
      case 'android-x64':
        return [['--target=x86_64-android-gcc', '--extra-cflags=-fPIC'], ''];
      case 'maccatalyst-arm64':
        return [
          [
            '--target=arm64-darwin20-gcc',
            `--extra-cflags=-target ${env(h, 'MCAT_TARGET')} -isysroot ${env(h, 'MCAT_SYSROOT')}`,
          ],
          '',
        ];
      case 'maccatalyst-x64':
        return [
          [
            '--target=x86_64-darwin20-gcc',
            `--extra-cflags=-target ${env(h, 'MCAT_TARGET')} -isysroot ${env(h, 'MCAT_SYSROOT')}`,
          ],
          '',
        ];
      case 'osx-x64':
        return [['--target=x86_64-darwin20-gcc', '--extra-cflags=-arch x86_64'], ''];
      case 'ios-arm64':
        return [
          [
            '--target=arm64-darwin-gcc',
            `--extra-cflags=-arch arm64 ${env(h, 'IOS_MINVER')} -isysroot ${env(h, 'IOS_SYSROOT')}`,
          ],
          '',
        ];
      default:
        return [[], ''];
    }
  };
  it.each(platformsOf('libvpx'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libvpx');
    const [args, crossPrefix] = extra(h);
    expect(h.calls.map((c) => [c.command, ...c.args])).toEqual([
      [
        './configure',
        `--prefix=${h.deps}`,
        '--disable-shared',
        '--enable-static',
        '--enable-vp8',
        '--enable-vp9',
        '--enable-vp9-highbitdepth',
        '--disable-examples',
        '--disable-tools',
        '--disable-docs',
        '--disable-unit-tests',
        '--enable-pic',
        ...args,
      ],
      ['make', '-j4'],
      ['make', 'install'],
    ]);
    for (const call of h.calls) {
      expect(call.env).toEqual(crossPrefix ? { CROSS: crossPrefix } : {});
    }
  });
});

describe('openssl', () => {
  // ./Configure "${OSSL_TARGET}" no-shared no-apps no-tests no-docs -fPIC --prefix --openssldir --libdir=lib [...]
  const target: Record<string, string> = {
    'linux-x64': 'linux-x86_64',
    'linux-musl-x64': 'linux-x86_64',
    'linux-arm64': 'linux-aarch64',
    'linux-musl-arm64': 'linux-aarch64',
    'linux-armhf': 'linux-armv4',
    'android-arm64': 'android-arm64',
    'android-x64': 'android-x86_64',
    'maccatalyst-arm64': 'darwin64-arm64-cc',
    'maccatalyst-x64': 'darwin64-x86_64-cc',
  };
  // installed for the neutral prefix into a staging folder, then copied into the deps folder: the folders libcrypto
  // compiles in, and its compiler line, name nothing of this machine's
  const staged = '/opt/ffmpeg-build/deps';
  const pc = (name: string, prefix: string) =>
    `prefix=${prefix}\nexec_prefix=\${prefix}\nlibdir=\${exec_prefix}/lib\nincludedir=\${prefix}/include\n\nName: ${name}\n`;
  const stageInstall = (h: ReturnType<typeof fake>) => {
    h.onRun = (call) => {
      if (call.command === 'make' && call.args[0] === 'install_sw') {
        const destdir = call.args[1]!.replace(/^DESTDIR=/, '');
        const root = join(destdir, ...staged.split('/').filter(Boolean));
        put(join(root, 'lib', 'libcrypto.a'), '!<arch>\n');
        put(join(root, 'lib', 'libssl.a'), '!<arch>\n');
        put(join(root, 'include', 'openssl', 'ssl.h'), 'h');
        for (const name of ['libcrypto', 'libssl', 'openssl']) {
          put(join(root, 'lib', 'pkgconfig', `${name}.pc`), pc(name, staged));
        }
      }
    };
  };
  it.each(platformsOf('openssl'))('%s', async (platform) => {
    const h = fake(platform);
    stageInstall(h);
    await build(h, 'openssl');
    const android = platform.startsWith('android-');
    expect(h.calls.map((c) => [c.command, ...c.args])).toEqual([
      [
        './Configure',
        target[platform]!,
        'no-shared',
        'no-apps',
        'no-tests',
        'no-docs',
        '-fPIC',
        `--prefix=${staged}`,
        '--openssldir=/etc/ssl',
        '--libdir=lib',
        ...(android ? ['-D__ANDROID_API__=28'] : []),
      ],
      ['make', 'crypto/buildinf.h', 'CC=cc', 'LIB_CFLAGS=', 'CPPFLAGS_Q='],
      ['make', '-j4'],
      ['make', 'install_sw', `DESTDIR=${h.src}/_stage`],
    ]);
    expect(h.files(h.deps)).toEqual([
      'include/openssl/ssl.h',
      'lib/libcrypto.a',
      'lib/libssl.a',
      'lib/pkgconfig/libcrypto.pc',
      'lib/pkgconfig/libssl.pc',
      'lib/pkgconfig/openssl.pc',
    ]);
    for (const name of ['libcrypto', 'libssl', 'openssl']) {
      expect(h.read(pcPath(h, name))).toBe(pc(name, h.deps));
    }
    // linux-armhf: export CROSS_COMPILE; android: unset CC CXX AR RANLIB NM STRIP, export ANDROID_NDK_ROOT and PATH;
    // Catalyst: export CC="${CC} -target ... -isysroot ..."
    let expected: Record<string, string | null> = {};
    if (platform === 'linux-armhf') {
      expected = { CROSS_COMPILE: 'arm-linux-gnueabihf-' };
    } else if (android) {
      expected = {
        CC: null,
        CXX: null,
        AR: null,
        RANLIB: null,
        NM: null,
        STRIP: null,
        ANDROID_NDK_ROOT: '/opt/ndk',
        PATH: `${env(h, 'TOOLCHAIN')}/bin:${env(h, 'PATH')}`,
      };
    } else if (platform.startsWith('maccatalyst-')) {
      expected = {
        CC: `${env(h, 'CC')} -target ${env(h, 'MCAT_TARGET')} -isysroot ${env(h, 'MCAT_SYSROOT')}`,
      };
    }
    for (const call of h.calls) {
      expect(call.env).toEqual(expected);
    }
  });
  it('fails when the staged install has no libcrypto', async () => {
    const h = fake('linux-x64');
    await expect(build(h, 'openssl')).rejects.toThrow(
      'OpenSSL staged install produced no lib/libcrypto.a',
    );
  });
});

describe('gnutls', () => {
  // GNUTLS_ARGS (+ --host when CROSS_HOST); CFLAGS="${CFLAGS:-} -std=gnu17" GMP_CFLAGS GMP_LIBS on configure only
  it.each(platformsOf('gnutls'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'gnutls');
    const host = env(h, 'CROSS_HOST');
    expect(h.calls.map((c) => [c.command, ...c.args])).toEqual([
      [
        './configure',
        `--prefix=${h.deps}`,
        `--libdir=${h.deps}/lib`,
        // the system priority file's path is compiled in: the system's, never the deps folder
        '--sysconfdir=/etc',
        '--disable-shared',
        '--enable-static',
        '--with-included-unistring',
        '--with-included-libtasn1=no',
        '--without-p11-kit',
        '--disable-doc',
        '--disable-tests',
        '--disable-tools',
        '--disable-cxx',
        '--disable-nls',
        '--without-idn',
        '--without-tpm',
        '--without-tpm2',
        '--without-zlib',
        '--without-brotli',
        '--without-zstd',
        ...(host ? [`--host=${host}`] : []),
      ],
      ['make', '-C', 'gl', '-j4'],
      ['make', '-C', 'lib', '-j4'],
      ['make', '-C', 'lib', 'install'],
    ]);
    expect(h.calls[0]!.env).toEqual({
      CFLAGS: `${env(h, 'CFLAGS')} -std=gnu17`,
      GMP_CFLAGS: `-I${h.deps}/include`,
      GMP_LIBS: `-L${h.deps}/lib -lgmp`,
    });
    for (const call of h.calls.slice(1)) {
      expect(call.env).toEqual({});
    }
  });
});

describe('nv-codec', () => {
  it.each(platformsOf('nv-codec'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'nv-codec');
    expect(commands(h)).toEqual([`make install PREFIX=${h.deps}`]);
  });
});

describe('libgsm', () => {
  // gsm_cc="${CC:-${CROSS_HOST:+${CROSS_HOST}-}gcc}" (ar, ranlib alike);
  // make -j lib/libgsm.a CC="${gsm_cc} -fPIC ${EXTRA_CFLAGS:-}" AR= ARFLAGS=cr RANLIB=; cp -a lib/libgsm.a inc/gsm.h
  it.each(platformsOf('libgsm'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'lib', 'libgsm.a'), '!<arch>\n');
    put(join(h.src, 'inc', 'gsm.h'), '/* gsm */\n');
    await build(h, 'libgsm');
    const host = env(h, 'CROSS_HOST');
    const tool = (name: string, fallback: string) =>
      env(h, name) || `${host ? `${host}-` : ''}${fallback}`;
    expect(h.calls.map((c) => [c.command, ...c.args])).toEqual([
      [
        'make',
        '-j4',
        'lib/libgsm.a',
        `CC=${tool('CC', 'gcc')} -fPIC ${env(h, 'EXTRA_CFLAGS')}`,
        `AR=${tool('AR', 'ar')}`,
        'ARFLAGS=cr',
        `RANLIB=${tool('RANLIB', 'ranlib')}`,
      ],
    ]);
    expect(h.files(h.deps)).toEqual(['include/gsm.h', 'lib/libgsm.a']);
    expect(h.read(join(h.deps, 'include', 'gsm.h'))).toBe('/* gsm */\n');
  });
  it('builds for the armhf triple, which sets no CC', async () => {
    const h = fake('linux-armhf');
    put(join(h.src, 'lib', 'libgsm.a'), '');
    put(join(h.src, 'inc', 'gsm.h'), '');
    await build(h, 'libgsm');
    expect(h.calls[0]!.args.slice(2)).toEqual([
      'CC=arm-linux-gnueabihf-gcc -fPIC ',
      'AR=arm-linux-gnueabihf-ar',
      'ARFLAGS=cr',
      'RANLIB=arm-linux-gnueabihf-ranlib',
    ]);
  });
});

describe('kissfft', () => {
  // mkdir -p deps/src/kissfft; cp -p ./*.c ./*.h dest/; cp -pR COPYING LICENSES dest/
  it.each(platformsOf('kissfft'))('%s', async (platform) => {
    const h = fake(platform);
    for (const path of [
      'kiss_fft.c',
      'kiss_fftr.c',
      'kiss_fft.h',
      'COPYING',
      'LICENSES/BSD-3-Clause',
      'tools/kiss_fftnd.c',
      'README.md',
    ]) {
      put(join(h.src, path), path);
    }
    await build(h, 'kissfft');
    expect(h.calls).toEqual([]);
    expect(h.files(h.deps)).toEqual([
      'src/kissfft/COPYING',
      'src/kissfft/LICENSES/BSD-3-Clause',
      'src/kissfft/kiss_fft.c',
      'src/kissfft/kiss_fft.h',
      'src/kissfft/kiss_fftr.c',
    ]);
  });
});

describe('zimg', () => {
  // retry git submodule update --init --recursive; ./autogen.sh; ZIMG_ARGS + case; configure; make; make install;
  // sed 's/^Libs.private:.*/Libs.private: -lstdc++ -lm/' zimg.pc
  const host: Record<string, string> = {
    'win-x64': 'x86_64-w64-mingw32',
    'win-arm64': 'aarch64-w64-mingw32',
    'linux-armhf': 'arm-linux-gnueabihf',
    'android-arm64': 'aarch64-linux-android',
    'android-x64': 'x86_64-linux-android',
    'ios-arm64': 'aarch64-apple-darwin',
    'ios-sim-arm64': 'aarch64-apple-darwin',
    'maccatalyst-arm64': 'aarch64-apple-darwin',
    'maccatalyst-x64': 'x86_64-apple-darwin',
    'osx-x64': 'x86_64-apple-darwin',
  };
  it('fetches its submodules recursively', () => {
    const source = recipe('zimg').source;
    expect('git' in source && source.submodules && submoduleArgs(source.submodules)).toEqual([
      'submodule',
      'update',
      '--init',
      '--recursive',
    ]);
  });
  it.each(platformsOf('zimg'))('%s', async (platform) => {
    const h = fake(platform);
    writeFileSync(pcPath(h, 'zimg'), `Libs: -L\${libdir} -lzimg\nLibs.private: -lstdc++\n`);
    await build(h, 'zimg');
    const args = [
      `--prefix=${h.deps}`,
      '--disable-shared',
      '--enable-static',
      '--with-pic',
      ...(host[platform] ? [`--host=${host[platform]}`] : []),
      ...(platform === 'win-arm64'
        ? [`CXXFLAGS=-O2 -include exception -I${h.src}/_zimg-compat`]
        : []),
    ];
    expect(commands(h)).toEqual([
      './autogen.sh',
      ['./configure', ...args].join(' '),
      'make -j4',
      'make install',
    ]);
    expect(h.read(pcPath(h, 'zimg'))).toBe(
      `Libs: -L\${libdir} -lzimg\nLibs.private: -lstdc++ -lm\n`,
    );
    expect(h.files(h.src)).toEqual(platform === 'win-arm64' ? ['_zimg-compat/Windows.h'] : []);
    // only win-arm64 writes the compat header; elsewhere the folder is empty, as checked above
    const header = join(h.src, '_zimg-compat', 'Windows.h');
    expect(existsSync(header) ? h.read(header) : undefined).toBe(
      platform === 'win-arm64' ? '#pragma once\n#include <windows.h>\n' : undefined,
    );
  });
});

describe('vulkan-loader', () => {
  it('builds where upstream bundles it: glibc and musl Linux, and macOS with MoltenVK', () => {
    expect(platformsOf('vulkan-loader')).toEqual([
      'linux-x64',
      'linux-arm64',
      'linux-musl-x64',
      'linux-musl-arm64',
      'osx-x64',
      'osx-arm64',
    ]);
  });
  it.each(platformsOf('vulkan-loader'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'vulkan-loader');
    // macOS: the toolchain's architecture (osx-x64 is cross-compiled), and /etc as the system configuration folder
    // rather than the deps folder, a path of the build machine
    const apple = platform.startsWith('osx-') ? [...cross(h), '-DSYSCONFDIR=/etc'] : [];
    expect(commands(h)).toEqual([
      [
        `cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -S . -B _build -DCMAKE_INSTALL_PREFIX=${h.deps} -DVULKAN_HEADERS_INSTALL_DIR=${h.deps} -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTS=OFF -DBUILD_WSI_XLIB_SUPPORT=OFF -DBUILD_WSI_XCB_SUPPORT=OFF -DBUILD_WSI_WAYLAND_SUPPORT=OFF -DBUILD_WSI_DIRECTFB_SUPPORT=OFF`,
        ...apple,
      ].join(' '),
      'cmake --build _build -j 4',
      'cmake --install _build',
    ]);
  });
});

describe('moltenvk', () => {
  // ./fetchDependencies --<target>; make <target>; osx: cp the dylib and MoltenVK_icd.json to deps/lib; ios-*,
  // maccatalyst-*: cp the static archive (checked with file -b) to deps/lib/libMoltenVK.a and libvulkan.a
  const target = (p: string) => {
    if (p.startsWith('osx-')) {
      return 'macos';
    }
    return p.startsWith('maccatalyst-') ? 'maccat' : 'ios';
  };
  it('builds on every Apple platform but the lean iOS simulator slice', () => {
    expect(platformsOf('moltenvk')).toEqual([
      'osx-x64',
      'osx-arm64',
      'ios-arm64',
      'maccatalyst-x64',
      'maccatalyst-arm64',
    ]);
  });
  it.each(platformsOf('moltenvk').filter((p) => p.startsWith('osx-')))(
    '%s: the dylib and its ICD manifest, pointing beside it',
    async (platform) => {
      const h = fake(platform);
      const dylibs = join(h.src, 'Package', 'Release', 'MoltenVK', 'dynamic', 'dylib', 'macOS');
      put(join(dylibs, 'libMoltenVK.dylib'), 'mach-o');
      put(
        join(dylibs, 'MoltenVK_icd.json'),
        '{\n  "file_format_version": "1.0.0",\n  "ICD": {\n    "library_path" : "../../../Lib/libMoltenVK.dylib",\n    "api_version": "1.4.0"\n  }\n}\n',
      );
      await build(h, 'moltenvk');
      expect(commands(h)).toEqual([
        './fetchDependencies --macos',
        'make macos',
        `strip -S -x ${h.deps}/lib/libMoltenVK.dylib`,
      ]);
      expect(h.files(join(h.deps, 'lib'))).toEqual(['MoltenVK_icd.json', 'libMoltenVK.dylib']);
      expect(h.read(join(h.deps, 'lib', 'MoltenVK_icd.json'))).toContain(
        '"library_path": "./libMoltenVK.dylib",',
      );
    },
  );
  it.each(platformsOf('moltenvk').filter((p) => !p.startsWith('osx-')))(
    '%s: the static archive, also as libvulkan.a',
    async (platform) => {
      const h = fake(platform);
      const slice = platform === 'ios-arm64' ? 'ios-arm64' : 'ios-arm64_x86_64-maccatalyst';
      const release = join(h.src, 'Package', 'Release', 'MoltenVK');
      // the dynamic flavour sorts first; the archive must still be the one taken
      put(
        join(release, 'dynamic', 'MoltenVK.xcframework', slice, 'MoltenVK.framework', 'MoltenVK'),
        'dylib',
      );
      put(join(release, 'static', 'MoltenVK.xcframework', slice, 'libMoltenVK.a'), '!<arch>\n');
      h.onRun = (call) => (call.command === 'file' ? 'current ar archive\n' : undefined);
      await build(h, 'moltenvk');
      expect(commands(h)).toEqual([
        `./fetchDependencies --${target(platform)}`,
        `make ${target(platform)}`,
        `file -b ${h.deps}/lib/libMoltenVK.a`,
        `strip -S ${h.deps}/lib/libMoltenVK.a`,
      ]);
      expect(h.files(join(h.deps, 'lib'))).toEqual(['libMoltenVK.a', 'libvulkan.a']);
      expect(h.read(join(h.deps, 'lib', 'libvulkan.a'))).toBe('!<arch>\n');
    },
  );
  it('fails when the archive it found is not one', async () => {
    const h = fake('ios-arm64');
    put(
      join(h.src, 'Package', 'Release', 'MoltenVK', 'static', 'x', 'ios-arm64', 'libMoltenVK.a'),
      '',
    );
    h.onRun = (call) =>
      call.command === 'file' ? 'Mach-O 64-bit dynamically linked shared library arm64\n' : '';
    await expect(build(h, 'moltenvk')).rejects.toThrow(
      'MoltenVK built no static archive for ios-arm64',
    );
  });
  it('fails when the build left no MoltenVK binary', async () => {
    await expect(build(fake('osx-arm64'), 'moltenvk')).rejects.toThrow(
      "MoltenVK's build left no libMoltenVK.dylib under Package/",
    );
    await expect(build(fake('maccatalyst-x64'), 'moltenvk')).rejects.toThrow(
      "MoltenVK's build left no libMoltenVK.a under Package/",
    );
  });
  it('is linked statically on iOS and Mac Catalyst, with the frameworks it calls', () => {
    const flags = recipe('moltenvk').configure;
    expect(flags).toEqual([
      { value: '--enable-vulkan' },
      { value: '--enable-vulkan-static' },
      {
        value:
          '--extra-libs=-lc++ -framework Metal -framework IOSurface -framework Foundation -framework QuartzCore -framework CoreGraphics -framework UIKit',
      },
      { value: '--extra-libs=-framework IOKit', platforms: ['maccatalyst-*'] },
    ]);
  });
});

describe('vulkan-shim', () => {
  // retry git submodule update --init --depth 1; cmake ...; cmake --build _build -j; lib=$(find _build -name libvulkan-1.a -o
  // -name libvulkan.a | head -1); file -b "${lib}" | grep -qiE archive; cp "${lib}" deps/lib/
  it('fetches its submodule shallow', () => {
    const source = recipe('vulkan-shim').source;
    expect('git' in source && source.submodules && submoduleArgs(source.submodules)).toEqual([
      'submodule',
      'update',
      '--init',
      '--depth',
      '1',
    ]);
  });
  it.each(platformsOf('vulkan-shim'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, '_build', 'shim', 'libvulkan-1.a'), '!<arch>\n');
    h.onRun = (call) => (call.command === 'file' ? 'current ar archive\n' : undefined);
    await build(h, 'vulkan-shim');
    expect(commands(h)).toEqual([
      [
        `cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -B _build -DCMAKE_INSTALL_PREFIX=${h.deps} -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_BUILD_TYPE=Release -DVULKAN_SHIM_IMPERSONATE=ON`,
        ...cross(h),
      ].join(' '),
      'cmake --build _build -j4',
      'file -b _build/shim/libvulkan-1.a',
    ]);
    expect(h.files(h.deps)).toEqual(['lib/libvulkan-1.a']);
  });
  it('fails without the archive, or with an import library', async () => {
    const none = fake('win-x64');
    await expect(build(none, 'vulkan-shim')).rejects.toThrow(
      'the Vulkan shim built no libvulkan-1.a / libvulkan.a',
    );
    const dll = fake('win-x64');
    put(join(dll.src, '_build', 'libvulkan.a'), '');
    dll.onRun = (call) => (call.command === 'file' ? 'PE32+ executable (DLL)\n' : undefined);
    await expect(build(dll, 'vulkan-shim')).rejects.toThrow(
      'the Vulkan shim is not a static archive: _build/libvulkan.a',
    );
  });
});

describe('libvpl', () => {
  // its own cmake line; case win-*) -lole32 -lgdi32 -luuid -lstdc++ ;; *) -lstdc++ -ldl; cat > vpl.pc
  it.each(platformsOf('libvpl'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libvpl');
    expect(h.calls.map((c) => [c.command, ...c.args])).toEqual([
      [
        'cmake',
        '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
        '-G',
        'Ninja',
        '-B',
        '_build',
        ...cross(h),
        `-DCMAKE_INSTALL_PREFIX=${h.deps}`,
        '-DCMAKE_INSTALL_LIBDIR=lib',
        '-DBUILD_DISPATCHER=ON',
        '-DBUILD_DEV=ON',
        '-DBUILD_PREVIEW=OFF',
        '-DBUILD_TOOLS=OFF',
        '-DBUILD_TOOLS_ONEVPL_EXPERIMENTAL=OFF',
        '-DINSTALL_EXAMPLE_CODE=OFF',
        '-DBUILD_SHARED_LIBS=OFF',
        '-DBUILD_TESTS=OFF',
        '-DCMAKE_C_FLAGS=-static-libgcc -O2',
        '-DCMAKE_CXX_FLAGS=-static-libgcc -static-libstdc++ -O2',
      ],
      ['cmake', '--build', '_build', '-j4'],
      ['cmake', '--install', '_build'],
    ]);
    const libs = platform.startsWith('win-') ? '-lole32 -lgdi32 -luuid -lstdc++' : '-lstdc++ -ldl';
    expect(h.read(pcPath(h, 'vpl'))).toBe(
      `prefix=${h.deps}\nlibdir=\${prefix}/lib\nincludedir=\${prefix}/include\n\nName: libvpl\nDescription: Intel Video Processing Library (oneVPL)\nVersion: 2.16\nLibs: -L\${libdir} -lvpl ${libs}\nCflags: -I\${includedir} -I\${includedir}/vpl\n`,
    );
  });
});

describe('shaderc', () => {
  // the sync (a Node operation already), cmake -B _build -G Ninja ..., cmake --build _build --target install -j N;
  // sed s/-lshaderc_shared/-lshaderc_combined/; rm -f lib/libshaderc_shared.*; Libs.private += ${CXX_RT_LIB} (or a
  // line after Libs:); rm -rf bin/glslc*
  const rt = (p: string): string => {
    if (/^(osx|ios|maccatalyst|android)-/.test(p)) {
      return '-lc++';
    }
    if (p.startsWith('linux-musl-')) {
      return '-l:libstdc++.a';
    }
    return p === 'win-arm64' ? '-l:libc++.a' : '-lstdc++';
  };
  it.each(platformsOf('shaderc'))('%s', async (platform) => {
    const h = fake(platform);
    writeFileSync(
      pcPath(h, 'shaderc'),
      `Libs: -L\${libdir} -lshaderc_shared\nLibs.private: -lpthread\n`,
    );
    for (const path of [
      'lib/libshaderc_shared.so',
      'lib/libshaderc_shared.so.1',
      'lib/libshaderc_combined.a',
      'bin/glslc',
      'bin/glslc.app/Contents/x',
      'bin/spirv-as',
    ]) {
      put(join(h.deps, path), '');
    }
    await build(h, 'shaderc');
    expect(commands(h).filter((c) => !c.startsWith('python'))).toEqual([
      [
        `cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -B _build -G Ninja -DCMAKE_INSTALL_PREFIX=${h.deps} -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_BUILD_TYPE=Release -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DSHADERC_SKIP_TESTS=ON -DSHADERC_SKIP_EXAMPLES=ON -DSHADERC_SKIP_COPYRIGHT_CHECK=ON -DSPIRV_SKIP_EXECUTABLES=ON -DENABLE_GLSLANG_BINARIES=OFF`,
        ...cross(h),
      ].join(' '),
      'cmake --build _build --target install -j 4',
    ]);
    expect(h.read(pcPath(h, 'shaderc'))).toBe(
      `Libs: -L\${libdir} -lshaderc_combined\nLibs.private: -lpthread ${rt(platform)}\n`,
    );
    expect(h.files(h.deps)).toEqual([
      'bin/spirv-as',
      'lib/libshaderc_combined.a',
      'lib/pkgconfig/shaderc.pc',
    ]);
  });
});

describe('fontconfig', () => {
  // rm -rf _stage; meson setup _build FC_ARGS cross; meson compile; DESTDIR=_stage meson install; cp -a _stage/usr/. deps/;
  // sed prefix=/libdir=/includedir= lines of fontconfig.pc to the deps folder; grep -q "^prefix=${DEPS_DIR}$"
  const installed = `prefix=/usr\nexec_prefix=\${prefix}\nlibdir=\${prefix}/lib\nincludedir=\${prefix}/include\n\nName: Fontconfig\nLibs: -L\${libdir} -lfontconfig\n`;
  it.each(platformsOf('fontconfig'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, '_stage', 'stale'), 'old');
    h.onRun = (call) => {
      if (call.command === 'meson' && call.args[0] === 'install') {
        const stage = call.env['DESTDIR']!;
        put(join(stage, 'usr', 'lib', 'pkgconfig', 'fontconfig.pc'), installed);
        put(join(stage, 'usr', 'lib', 'libfontconfig.a'), '!<arch>\n');
        put(join(stage, 'usr', 'include', 'fontconfig', 'fontconfig.h'), 'h');
        put(join(stage, 'etc', 'fonts', 'fonts.conf'), 'conf');
      }
    };
    await build(h, 'fontconfig');
    expect(commands(h)).toEqual([
      [
        'meson setup _build --prefix=/usr --libdir=/usr/lib --sysconfdir=/etc --localstatedir=/var --default-library=static --buildtype=release -Ddoc=disabled -Dtests=disabled -Dtools=disabled -Dcache-build=disabled -Dnls=disabled',
        ...h.context.toolchain.mesonArgs,
      ].join(' '),
      'meson compile -C _build -j 4',
      `meson install -C _build [DESTDIR=${h.src}/_stage]`,
    ]);
    expect(h.files(h.deps)).toEqual([
      'include/fontconfig/fontconfig.h',
      'lib/libfontconfig.a',
      'lib/pkgconfig/fontconfig.pc',
    ]);
    expect(h.read(pcPath(h, 'fontconfig'))).toBe(
      `prefix=${h.deps}\nexec_prefix=\${prefix}\nlibdir=${h.deps}/lib\nincludedir=${h.deps}/include\n\nName: Fontconfig\nLibs: -L\${libdir} -lfontconfig\n`,
    );
  });
  it('fails when the staged install has no /usr', async () => {
    const h = fake('linux-x64');
    await expect(build(h, 'fontconfig')).rejects.toThrow(
      'fontconfig DESTDIR install produced no /usr tree',
    );
  });
});

// Batch b of #21 (GPU and hardware): the libraries behind opencl, vdpau, d3d12va and rkmpp. (cuda-llvm needs no
// library of its own: nv-codec's headers and the image's clang.)
describe('opencl-headers', () => {
  it('builds where the OpenCL ICD loader does: Linux and Windows', () => {
    expect(platformsOf('opencl-headers')).toEqual([
      'linux-x64',
      'linux-arm64',
      'linux-armhf',
      'linux-musl-x64',
      'linux-musl-arm64',
      'win-x64',
      'win-arm64',
    ]);
  });
  // OpenCL-Headers.pc moved to where pkg-config looks (their CMake install puts it in share/pkgconfig)
  it.each(platformsOf('opencl-headers'))('%s', async (platform) => {
    const h = fake(platform);
    const pc = `prefix=${h.deps}\nincludedir=\${prefix}/include\n\nName: OpenCL-Headers\nCflags: -I\${includedir}\n`;
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        put(join(h.deps, 'include', 'CL', 'cl.h'), '/* cl */\n');
        put(join(h.deps, 'share', 'pkgconfig', 'OpenCL-Headers.pc'), pc);
      }
      return undefined;
    };
    await build(h, 'opencl-headers');
    expect(commands(h)).toEqual(cmakeLines(h, ['-DBUILD_TESTING=OFF']));
    expect(h.files(h.deps)).toEqual(['include/CL/cl.h', 'lib/pkgconfig/OpenCL-Headers.pc']);
    expect(h.read(pcPath(h, 'OpenCL-Headers'))).toBe(pc);
  });
});

// The Khronos ICD loader, static, against the headers in deps; mingw names it OpenCL.a, which -lOpenCL can't find, and
// its .pc leaves out ole32 (StringFromGUID2) on Windows.
describe('opencl-icd-loader', () => {
  const pc = (privates: string) =>
    `Name: OpenCL\nRequires: OpenCL-Headers\nLibs: -L\${libdir} -lOpenCL\nLibs.private: ${privates}\n`;
  it.each(platformsOf('opencl-icd-loader'))('%s', async (platform) => {
    const h = fake(platform);
    const win = platform.startsWith('win-');
    const privates = win ? '-lcfgmgr32 -lruntimeobject' : '-pthread -ldl';
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        put(join(h.deps, 'lib', win ? 'OpenCL.a' : 'libOpenCL.a'), '!<arch>\n');
        put(pcPath(h, 'OpenCL'), pc(privates));
      }
      return undefined;
    };
    await build(h, 'opencl-icd-loader');
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        `-DOPENCL_ICD_LOADER_HEADERS_DIR=${h.deps}/include`,
        '-DENABLE_OPENCL_LAYERINFO=OFF',
        '-DOPENCL_ICD_LOADER_BUILD_TESTING=OFF',
        '-DBUILD_TESTING=OFF',
      ]),
    );
    expect(h.files(join(h.deps, 'lib'))).toEqual(['libOpenCL.a', 'pkgconfig/OpenCL.pc']);
    expect(h.read(pcPath(h, 'OpenCL'))).toBe(pc(win ? `${privates} -lole32` : privates));
  });
  it('needs the headers, and is the opencl option', () => {
    expect(recipe('opencl-icd-loader').needs).toEqual([{ name: 'opencl-headers' }]);
    expect(valuesOn(recipe('opencl-icd-loader'), 'configure')).toEqual(['--enable-opencl']);
    expect(platformsOf('opencl-icd-loader')).toEqual(platformsOf('opencl-headers'));
  });
});

// Only vdpau/vdpau.h: FFmpeg reaches the driver through a VdpDevice's function pointers; libvdpau itself, and the
// vdpau_x11 device creation, would need libX11.
describe('libvdpau', () => {
  it.each(platformsOf('libvdpau'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'include', 'vdpau', 'vdpau.h'), '/* vdpau */\n');
    put(join(h.src, 'include', 'vdpau', 'vdpau_x11.h'), '#include <X11/Xlib.h>\n');
    await build(h, 'libvdpau');
    expect(commands(h)).toEqual([]);
    expect(h.files(join(h.deps, 'include'))).toEqual(['vdpau/vdpau.h']);
    expect(h.read(join(h.deps, 'include', 'vdpau', 'vdpau.h'))).toBe('/* vdpau */\n');
  });
  it('builds on Linux only', () => {
    expect(platformsOf('libvdpau')).toEqual([
      'linux-x64',
      'linux-arm64',
      'linux-armhf',
      'linux-musl-x64',
      'linux-musl-arm64',
    ]);
  });
});

// win-x64's mingw-w64 11.0.1 has no d3d12video.h: a newer mingw-w64's three headers FFmpeg's d3d12va needs, over the
// toolchain's own. (win-arm64's llvm-mingw has them.)
describe('d3d12-headers', () => {
  it('builds for win-x64 only', () => {
    expect(platformsOf('d3d12-headers')).toEqual(['win-x64']);
  });
  it('copies d3d12.h, d3d12video.h and dxva.h', async () => {
    const h = fake('win-x64');
    for (const name of ['d3d12.h', 'd3d12video.h', 'dxva.h', 'd3d11.h']) {
      put(join(h.src, 'mingw-w64-headers', 'include', name), `/* ${name} */\n`);
    }
    await build(h, 'd3d12-headers');
    expect(commands(h)).toEqual([]);
    expect(h.files(join(h.deps, 'include'))).toEqual(['d3d12.h', 'd3d12video.h', 'dxva.h']);
    expect(h.read(join(h.deps, 'include', 'd3d12video.h'))).toBe('/* d3d12video.h */\n');
  });
});

// Rockchip MPP: CMake builds the shared and static libraries either way; the shared ones go, so FFmpeg links the
// static one, and its .pc gains the threads it needs.
describe('rockchip-mpp', () => {
  it('builds on ARM Linux only', () => {
    expect(platformsOf('rockchip-mpp')).toEqual(['linux-arm64', 'linux-armhf', 'linux-musl-arm64']);
  });
  it.each(platformsOf('rockchip-mpp'))('%s', async (platform) => {
    const h = fake(platform);
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        for (const name of [
          'librockchip_mpp.a',
          'librockchip_mpp.so',
          'librockchip_mpp.so.1',
          'librockchip_mpp.so.0.1.0',
          'librockchip_vpu.so',
          'librockchip_vpu.so.1',
        ]) {
          put(join(h.deps, 'lib', name), '');
        }
        put(
          pcPath(h, 'rockchip_mpp'),
          `Name: rockchip_mpp\nVersion: 1.3.10\nLibs: -L\${libdir} -lrockchip_mpp -lm\nLibs.private:\nCflags: -I\${includedir}\n`,
        );
      }
      return undefined;
    };
    await build(h, 'rockchip-mpp');
    expect(commands(h)).toEqual(cmakeLines(h, ['-DBUILD_TEST=OFF']));
    expect(h.files(join(h.deps, 'lib'))).toEqual([
      'librockchip_mpp.a',
      'pkgconfig/rockchip_mpp.pc',
    ]);
    expect(h.read(pcPath(h, 'rockchip_mpp'))).toBe(
      `Name: rockchip_mpp\nVersion: 1.3.10\nLibs: -L\${libdir} -lrockchip_mpp -lm\nLibs.private: -lpthread\nCflags: -I\${includedir}\n`,
    );
  });
  it("needs libdrm, and turns FFmpeg's on with rkmpp", () => {
    expect(recipe('rockchip-mpp').needs).toEqual([{ name: 'libdrm' }]);
    expect(valuesOn(recipe('rockchip-mpp'), 'configure')).toEqual([
      '--enable-rkmpp',
      '--enable-libdrm',
    ]);
  });
});
