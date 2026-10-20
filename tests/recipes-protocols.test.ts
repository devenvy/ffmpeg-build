// Batch e of #21 (protocols and I/O): each library's build on every platform it builds on, with the process runner
// stubbed, and the files it leaves in deps.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  build,
  cmakeLines,
  commands,
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
