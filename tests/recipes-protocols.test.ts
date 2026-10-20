// Batch e of #21 (protocols and I/O): each library's build on every platform it builds on, with the process runner
// stubbed, and the files it leaves in deps.
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
/** Writes a .pc file when `cmake --install` runs, as the library's install would. */
const installs = (h: Harness, name: string, text: string) => {
  h.onRun = (call) => {
    if (call.command === 'cmake' && call.args[0] === '--install') {
      put(pcPath(h, name), text);
    }
    return undefined;
  };
};
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

// ZeroMQ's static library alone, without the draft API, CURVE, WebSocket or libbsd; its .pc's libstdc++ the platform's
// C++ runtime, and on Windows the define that makes zmq.h declare the static library's symbols, and the system
// libraries it calls.
describe('libzmq', () => {
  it.each(platformsOf('libzmq'))('%s', async (platform) => {
    const h = fake(platform);
    installs(
      h,
      'libzmq',
      `Name: libzmq\nLibs: -L\${libdir} -lzmq\nLibs.private: -lstdc++  -lrt\nRequires.private: \nCflags: -I\${includedir} \n`,
    );
    const clock =
      '#ifndef ZMQ_HAVE_WINDOWS\nconst uint64_t usecs_per_msec = 1000;\nconst uint64_t nsecs_per_usec = 1000;\n#endif\n';
    put(join(h.src, 'src', 'clock.cpp'), clock);
    put(join(h.src, 'src', 'polling_util.hpp'), '#include <stdlib.h>\n#include <vector>\n');
    await build(h, 'libzmq');
    expect(h.read(join(h.src, 'src', 'polling_util.hpp'))).toBe(
      `#include <stdlib.h>\n#include <vector>\n${platform === 'win-arm64' ? '#include <new>\n' : ''}`,
    );
    // llvm-mingw's arm64 build takes the clock_gettime path, which needs nsecs_per_usec on Windows too
    expect(h.read(join(h.src, 'src', 'clock.cpp'))).toBe(
      platform === 'win-arm64'
        ? '#ifndef ZMQ_HAVE_WINDOWS\nconst uint64_t usecs_per_msec = 1000;\n#endif\nconst uint64_t nsecs_per_usec = 1000;\n'
        : clock,
    );
    const win = platform.startsWith('win-');
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DBUILD_SHARED=OFF',
        '-DBUILD_STATIC=ON',
        '-DBUILD_TESTS=OFF',
        '-DWITH_PERF_TOOL=OFF',
        '-DWITH_DOCS=OFF',
        '-DENABLE_CPACK=OFF',
        '-DENABLE_DRAFTS=OFF',
        '-DENABLE_CURVE=OFF',
        '-DWITH_LIBSODIUM=OFF',
        '-DWITH_LIBBSD=OFF',
        '-DENABLE_PRECOMPILED=OFF',
        // a cross build has no CMAKE_SYSTEM_VERSION to take _WIN32_WINNT from
        ...(win ? ['-DZMQ_WIN32_WINNT=0x0600', '-DZMQ_HAVE_IPC=OFF'] : []),
      ]),
    );
    expect(h.read(pcPath(h, 'libzmq'))).toBe(
      `Name: libzmq\nLibs: -L\${libdir} -lzmq\n` +
        `Libs.private:  -lrt ${cxxRuntime(platform)}${win ? ' -lpthread -lws2_32 -liphlpapi -lrpcrt4' : ''}\n` +
        `Requires.private: \nCflags: -I\${includedir} ${win ? ' -DZMQ_STATIC' : ''}\n`,
    );
  });
  it('is MPL-2.0, and builds everywhere', () => {
    expect(recipe('libzmq').license).toBe('MPL-2.0');
    expect(platformsOf('libzmq')).toEqual(PLATFORMS);
  });
});

// rabbitmq-c's static library alone, without SSL; its .pc gains the define its headers export through.
describe('rabbitmq-c', () => {
  it.each(platformsOf('rabbitmq-c'))('%s', async (platform) => {
    const h = fake(platform);
    installs(
      h,
      'librabbitmq',
      `Name: rabbitmq-c\nLibs: -L\${libdir} -lrabbitmq\nLibs.private: \nCflags: -I\${includedir}\n`,
    );
    await build(h, 'rabbitmq-c');
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DBUILD_STATIC_LIBS=ON',
        '-DINSTALL_STATIC_LIBS=ON',
        '-DENABLE_SSL_SUPPORT=OFF',
        '-DBUILD_EXAMPLES=OFF',
        '-DBUILD_TOOLS=OFF',
        '-DBUILD_API_DOCS=OFF',
        '-DBUILD_TESTING=OFF',
      ]),
    );
    expect(h.read(pcPath(h, 'librabbitmq'))).toBe(
      `Name: rabbitmq-c\nLibs: -L\${libdir} -lrabbitmq\nLibs.private: \nCflags: -I\${includedir} -DAMQP_STATIC\n`,
    );
  });
  it('is MIT, and builds everywhere', () => {
    expect(recipe('rabbitmq-c').license).toBe('MIT');
    expect(platformsOf('rabbitmq-c')).toEqual(PLATFORMS);
  });
});

// Snappy's static library alone, without -Werror; FFmpeg's link gets the platform's C++ runtime (it finds Snappy with
// `-lsnappy -lstdc++`, no pkg-config).
describe('snappy', () => {
  it.each(platformsOf('snappy'))('%s', async (platform) => {
    const h = fake(platform);
    put(
      join(h.src, 'CMakeLists.txt'),
      `  if(NOT CMAKE_CXX_FLAGS MATCHES "-Werror")\n    set(CMAKE_CXX_FLAGS "\${CMAKE_CXX_FLAGS} -Werror")\n  endif()\n`,
    );
    await build(h, 'snappy');
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DSNAPPY_BUILD_TESTS=OFF',
        '-DSNAPPY_BUILD_BENCHMARKS=OFF',
        '-DSNAPPY_INSTALL=ON',
      ]),
    );
    expect(h.read(join(h.src, 'CMakeLists.txt'))).toBe(
      '  if(NOT CMAKE_CXX_FLAGS MATCHES "-Werror")\n    \n  endif()\n',
    );
  });
  it('is BSD-3-Clause, builds everywhere, and puts the C++ runtime on FFmpeg’s link', () => {
    expect(recipe('snappy').license).toBe('BSD-3-Clause');
    expect(platformsOf('snappy')).toEqual(PLATFORMS);
  });
});

// libssh's static client library on mbedTLS, without server, GSSAPI, zlib, libnacl or pcap; its .pc gains mbedTLS's
// crypto library, and on Windows LIBSSH_STATIC and the system libraries.
describe('libssh', () => {
  it.each(platformsOf('libssh'))('%s', async (platform) => {
    const h = fake(platform);
    installs(h, 'libssh', `Name: libssh\nLibs: -L\${libdir} -lssh\nCflags: -I\${includedir}\n`);
    const misc =
      'if ((buffer.st_mode & _S_IFDIR) && (buffer.st_mode & _S_IWRITE)) {\n' +
      'if (S_ISDIR(buffer.st_mode) && (buffer.st_mode & S_IWRITE)) {\n';
    put(join(h.src, 'src', 'misc.c'), misc);
    await build(h, 'libssh');
    const android = platform.startsWith('android-');
    // Bionic has no S_IWRITE (S_IWUSR's old name); Windows' _S_IWRITE stays
    expect(h.read(join(h.src, 'src', 'misc.c'))).toBe(
      android ? misc.replace('& S_IWRITE)', '& S_IWUSR)') : misc,
    );
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DWITH_MBEDTLS=ON',
        '-DWITH_GCRYPT=OFF',
        '-DWITH_GSSAPI=OFF',
        '-DWITH_ZLIB=OFF',
        '-DWITH_SERVER=OFF',
        '-DWITH_NACL=OFF',
        '-DWITH_PCAP=OFF',
        '-DWITH_EXAMPLES=OFF',
        '-DWITH_BENCHMARKS=OFF',
        '-DWITH_SYMBOL_VERSIONING=OFF',
        '-DUNIT_TESTING=OFF',
        '-DCLIENT_TESTING=OFF',
        '-DSERVER_TESTING=OFF',
        // the NDK's toolchain file finds only in its sysroot, and Bionic's glob() lacks GLOB_TILDE
        ...(android ? [`-DCMAKE_FIND_ROOT_PATH=${h.deps}`, '-DHAVE_GLOB=0'] : []),
      ]),
    );
    expect(h.read(pcPath(h, 'libssh'))).toBe(
      `Name: libssh\nLibs: -L\${libdir} -lssh\nLibs.private: -lmbedcrypto\nCflags: -I\${includedir}\n`,
    );
  });
  it('is on mbedTLS, everywhere its mbedTLS is thread-safe: not Windows', () => {
    expect(recipe('libssh').needs).toEqual([{ name: 'mbedtls' }]);
    expect(platformsOf('libssh')).toEqual(PLATFORMS.filter((p) => !p.startsWith('win-')));
  });
});

// mbedTLS with its pthread locking where the C library has pthreads (libssh needs it), the default configuration on
// Windows.
describe('mbedtls', () => {
  const CONFIG =
    '//#define MBEDTLS_THREADING_ALT\n//#define MBEDTLS_THREADING_PTHREAD\n//#define MBEDTLS_THREADING_C\n';
  it.each(platformsOf('mbedtls'))('%s', async (platform) => {
    const h = fake(platform);
    put(join(h.src, 'include', 'mbedtls', 'mbedtls_config.h'), CONFIG);
    installs(
      h,
      'mbedcrypto',
      `Version: 3.6.7\nCflags: -I"\${includedir}"\nLibs: -L"\${libdir}" -lmbedcrypto\n`,
    );
    await build(h, 'mbedtls');
    // on Windows the crypto library's .pc names bcrypt and ws2_32, which mbedcrypto and mbedx509 call
    expect(h.read(pcPath(h, 'mbedcrypto'))).toBe(
      `Version: 3.6.7\nCflags: -I"\${includedir}"\nLibs: -L"\${libdir}" -lmbedcrypto\n${
        platform.startsWith('win-') ? 'Libs.private: -lbcrypt -lws2_32\n' : ''
      }`,
    );
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DUSE_SHARED_MBEDTLS_LIBRARY=OFF',
        '-DUSE_STATIC_MBEDTLS_LIBRARY=ON',
        '-DENABLE_TESTING=OFF',
        '-DENABLE_PROGRAMS=OFF',
      ]),
    );
    expect(h.read(join(h.src, 'include', 'mbedtls', 'mbedtls_config.h'))).toBe(
      platform.startsWith('win-')
        ? CONFIG
        : '//#define MBEDTLS_THREADING_ALT\n#define MBEDTLS_THREADING_PTHREAD\n#define MBEDTLS_THREADING_C\n',
    );
  });
});

// librtmp's library and .pc from rtmpdump's Makefile with the platform's tools, static; GnuTLS for its encryption
// when the build has it, none otherwise.
describe('librtmp', () => {
  /** rtmpdump's SYS: the system libraries its .pc names. */
  const sysOf = (platform: string) => {
    if (platform.startsWith('win-')) {
      return 'mingw';
    }
    return /^(osx|ios|maccatalyst)-/.test(platform) ? 'darwin' : 'posix';
  };
  const cases = platformsOf('librtmp').flatMap((p) => [
    [p, false],
    [p, true],
  ]) as [string, boolean][];
  it.each(cases)('%s, GnuTLS in deps: %s', async (platform, gnutls) => {
    const h = fake(platform);
    if (gnutls) {
      put(join(h.deps, 'lib', 'libgnutls.a'), '');
    }
    put(join(h.deps, 'man', 'man3', 'librtmp.3'), '');
    const src = (f: string) => join(h.src, 'librtmp', f);
    put(
      src('rtmp.c'),
      '#include <nettle/md5.h>\n#define MD5_Final(dig,ctx)\tmd5_digest(ctx,MD5_DIGEST_LENGTH,dig)\n',
    );
    const hmac =
      '#include <nettle/hmac.h>\n#define HMAC_finish(ctx, dig, dlen)\tdlen = SHA256_DIGEST_LENGTH; hmac_sha256_digest(&ctx, SHA256_DIGEST_LENGTH, dig)\n';
    put(src('hashswf.c'), hmac);
    put(src('handshake.h'), hmac);
    await build(h, 'librtmp');
    // Nettle 4's digest functions take no length: a macro gives it to Nettle 3 only
    expect(h.read(src('nettle_compat.h'))).toBe(
      '#include <nettle/version.h>\n#if NETTLE_VERSION_MAJOR >= 4\n#define NETTLE_LENGTH_ARG(n)\n#else\n' +
        '#define NETTLE_LENGTH_ARG(n) n,\n#endif\n',
    );
    expect(h.read(src('rtmp.c'))).toBe(
      '#include <nettle/md5.h>\n#include "nettle_compat.h"\n' +
        '#define MD5_Final(dig,ctx)\tmd5_digest(ctx,NETTLE_LENGTH_ARG(MD5_DIGEST_LENGTH)dig)\n',
    );
    for (const f of ['hashswf.c', 'handshake.h']) {
      expect(h.read(src(f)), f).toBe(
        '#include <nettle/hmac.h>\n#include "nettle_compat.h"\n#define HMAC_finish(ctx, dig, dlen)\tdlen = ' +
          'SHA256_DIGEST_LENGTH; hmac_sha256_digest(&ctx, NETTLE_LENGTH_ARG(SHA256_DIGEST_LENGTH) dig)\n',
      );
    }
    const host = h.context.env['CROSS_HOST'] ?? '';
    const tools = host ? `${host}-` : '';
    const args = [
      `CC=${h.context.env['CC'] ?? `${tools}gcc`}`,
      `AR=${h.context.env['AR'] ?? `${tools}ar`}`,
      `SYS=${sysOf(platform)}`,
      `CRYPTO=${gnutls ? 'GNUTLS' : ''}`,
      'SHARED=no',
      `prefix=${h.deps}`,
      `XCFLAGS=-fPIC ${h.context.env['CFLAGS'] ?? ''} -I${h.deps}/include`,
    ].join(' ');
    expect(commands(h)).toEqual([
      `make -C librtmp -j4 librtmp.a librtmp.pc ${args}`,
      `make -C librtmp install_base ${args}`,
    ]);
    expect(h.files(h.deps).filter((f) => f.startsWith('man/'))).toEqual([]);
  });
  it('is LGPL-2.1-or-later, needs zlib and uses GnuTLS where the build allows it', () => {
    expect(recipe('librtmp').license).toBe('LGPL-2.1-or-later');
    expect(recipe('librtmp').needs).toEqual([{ name: 'zlib' }]);
    expect(recipe('librtmp').uses).toEqual([{ name: 'gnutls' }]);
    expect(platformsOf('librtmp')).toEqual(PLATFORMS);
  });
});

// GMP everywhere now (FFmpeg's gmp option), configured as before.
describe('gmp', () => {
  it('builds everywhere, for FFmpeg’s gmp option', () => {
    expect(platformsOf('gmp')).toEqual(PLATFORMS);
    expect(recipe('gmp').provides).toBe('gmp');
  });
});

// Discs: Blu-ray (libbluray on libudfread and libxml2), DVD-Video (libdvdread, libdvdnav) and audio CDs (libcdio,
// libcdio-paranoia), each a static library alone.
const NOT_APPLE_MOBILE = PLATFORMS.filter((p) => /^(linux|win|osx|android)-/.test(p));
const DESKTOP = PLATFORMS.filter((p) => /^(linux|win|osx)-/.test(p));
describe('libudfread', () => {
  it.each(platformsOf('libudfread'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libudfread');
    expect(commands(h)).toEqual(mesonLines(h, ['-Denable_examples=false']));
  });
  it('builds where libbluray does', () => {
    expect(platformsOf('libudfread')).toEqual(platformsOf('libbluray'));
  });
});

describe('libbluray', () => {
  it.each(platformsOf('libbluray'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libbluray');
    expect(commands(h)).toEqual(
      mesonLines(h, [
        '-Denable_tools=false',
        '-Denable_examples=false',
        '-Denable_docs=false',
        '-Dbdj_jar=disabled',
        '-Dfreetype=disabled',
        '-Dfontconfig=disabled',
        '-Dlibxml2=enabled',
        '-Dembed_udfread=false',
      ]),
    );
  });
  it('is LGPL-2.1-or-later on libudfread and libxml2; not iOS or Mac Catalyst', () => {
    expect(recipe('libbluray').license).toBe('LGPL-2.1-or-later');
    expect(recipe('libbluray').needs).toEqual([{ name: 'libudfread' }, { name: 'libxml2' }]);
    expect(platformsOf('libbluray')).toEqual(NOT_APPLE_MOBILE);
  });
});

describe('libdvdread and libdvdnav', () => {
  it.each(platformsOf('libdvdread'))('libdvdread %s', async (platform) => {
    const h = fake(platform);
    const header = join(h.src, 'src', 'dvdread', 'dvd_filesystem.h');
    put(header, '#elif defined(__APPLE__) || defined(__FreeBSD__)\ntypedef off_t off64_t;\n');
    await build(h, 'libdvdread');
    expect(commands(h)).toEqual(mesonLines(h, ['-Denable_docs=false', '-Dlibdvdcss=disabled']));
    // musl has no off64_t unless asked first: it takes the BSDs' typedef (its off_t is 64-bit)
    expect(h.read(header)).toBe(
      `#elif ${platform.startsWith('linux-musl-') ? 'defined(__linux__) || ' : ''}defined(__APPLE__) || defined(__FreeBSD__)\ntypedef off_t off64_t;\n`,
    );
  });
  it.each(platformsOf('libdvdnav'))('libdvdnav %s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libdvdnav');
    expect(commands(h)).toEqual(mesonLines(h, ['-Denable_docs=false', '-Denable_examples=false']));
  });
  it('are GPL-2.0-or-later, everywhere', () => {
    expect(recipe('libdvdread').license).toBe('GPL-2.0-or-later');
    expect(recipe('libdvdnav').license).toBe('GPL-2.0-or-later');
    expect(recipe('libdvdnav').needs).toEqual([{ name: 'libdvdread' }]);
    expect(platformsOf('libdvdread')).toEqual(PLATFORMS);
    expect(platformsOf('libdvdnav')).toEqual(PLATFORMS);
  });
});

describe('libcdio and libcdio-paranoia', () => {
  const libraryOnly = (h: Harness, args: string[]) => [
    configureLine(h, ['--disable-shared', '--enable-static', '--with-pic', ...args]),
    'make -j4 -C lib',
    'make -C lib install',
    'make -C include install',
    'make install-pkgconfigDATA',
  ];
  it.each(platformsOf('libcdio'))('libcdio %s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libcdio');
    expect(commands(h)).toEqual(
      libraryOnly(h, [
        '--disable-cxx',
        '--disable-cpp-progs',
        '--disable-example-progs',
        '--disable-joliet',
        '--disable-cddb',
        '--disable-vcd-info',
        '--disable-rpath',
        '--without-cd-drive',
        '--without-cd-info',
        '--without-cdda-player',
        '--without-cd-read',
        '--without-iso-info',
        '--without-iso-read',
      ]),
    );
  });
  it.each(platformsOf('libcdio-paranoia'))('libcdio-paranoia %s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libcdio-paranoia');
    expect(commands(h)).toEqual(
      libraryOnly(h, ['--disable-cxx', '--disable-cpp-progs', '--disable-example-progs']),
    );
  });
  it('are GPL-3.0-or-later, where CD drives are: Linux, Windows and macOS', () => {
    expect(recipe('libcdio').license).toBe('GPL-3.0-or-later');
    expect(recipe('libcdio-paranoia').license).toBe('GPL-3.0-or-later');
    expect(recipe('libcdio-paranoia').needs).toEqual([{ name: 'libcdio' }]);
    expect(platformsOf('libcdio')).toEqual(DESKTOP);
    expect(platformsOf('libcdio-paranoia')).toEqual(DESKTOP);
  });
});

// Scripts: AviSynth+'s and VapourSynth's headers alone (FFmpeg loads them at run time), where they run.
describe('avisynth-headers', () => {
  it.each(platformsOf('avisynth-headers'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'avisynth-headers');
    // its HEADERS_ONLY install, with the generated version.h (a target of its own) made first
    expect(commands(h)).toEqual([
      [
        'cmake -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -B _build -S .',
        `-DCMAKE_INSTALL_PREFIX=${h.deps}`,
        '-DCMAKE_INSTALL_INCLUDEDIR=include -DHEADERS_ONLY=ON',
        ...h.context.toolchain.cmakeArgs,
      ].join(' '),
      'cmake --build _build --target VersionGen',
      'cmake --install _build',
    ]);
  });
  it('is GPL-2.0-or-later, on Linux, Windows and macOS', () => {
    expect(recipe('avisynth-headers').license).toBe('GPL-2.0-or-later');
    expect(platformsOf('avisynth-headers')).toEqual(DESKTOP);
  });
});

describe('vapoursynth-headers', () => {
  it.each(platformsOf('vapoursynth-headers'))('%s', async (platform) => {
    const h = fake(platform);
    const names = ['VapourSynth4.h', 'VSScript4.h', 'VSHelper4.h', 'VSConstants4.h'];
    for (const n of names) {
      put(join(h.src, 'include', n), n);
    }
    await build(h, 'vapoursynth-headers');
    expect(commands(h)).toEqual([]);
    expect(h.files(join(h.deps, 'include', 'vapoursynth'))).toEqual([...names].sort());
  });
  it('is LGPL-2.1-or-later, on Linux, Windows and macOS', () => {
    expect(recipe('vapoursynth-headers').license).toBe('LGPL-2.1-or-later');
    expect(platformsOf('vapoursynth-headers')).toEqual(DESKTOP);
  });
});
