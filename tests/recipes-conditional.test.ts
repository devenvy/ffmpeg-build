// Recipes whose bash chose what to build from what the deps folder held (mbedTLS for srt and librist, the Vulkan
// loader or shim for whisper.cpp) and checked the result. Each runs on every platform it builds on, with and without
// the optional library, against what the old `shell:` step did, as read from it (quoted in the comments).
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
} from './recipe-harness.ts';

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
const put = (path: string, text = '') => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const env = (h: Harness, name: string) => h.context.env[name] ?? '';
const cxxRt = (p: string): string => {
  if (/^(osx|ios|maccatalyst|android)-/.test(p)) {
    return '-lc++';
  }
  if (p === 'win-arm64') {
    return '-l:libc++.a';
  }
  return p.startsWith('linux-musl-') ? '-l:libstdc++.a' : '-lstdc++';
};
/** whisper.cpp: what the deps folder holds before the build, and what the install leaves in it. */
function seedWhisper(h: Harness, platform: string, loader: boolean, backend: string): void {
  put(join(h.deps, 'include', 'vulkan', 'vulkan.h'));
  put(join(h.deps, 'share', 'cmake', 'SPIRV-Headers', 'SPIRV-HeadersConfig.cmake'));
  if (loader && ['linux-x64', 'linux-arm64', 'linux-musl'].some((p) => platform.startsWith(p))) {
    put(join(h.deps, 'lib', 'libvulkan.so.1'));
  }
  if (loader && platform.startsWith('win-')) {
    put(join(h.deps, 'lib', 'libvulkan-1.a'));
  }
  // what the install leaves: mingw names some archives without lib; BLAS is auto-enabled on Apple
  for (const archive of [
    'ggml.a',
    'ggml-base.a',
    'libggml-cpu.a',
    ...(backend === 'cpu' ? [] : [`ggml-${backend}.a`]),
    ...(backend === 'metal' ? ['libggml-blas.a'] : []),
  ]) {
    put(join(h.deps, 'lib', archive));
  }
  if (platform === 'linux-musl-x64' || platform === 'linux-musl-arm64') {
    h.onRun = (call) =>
      call.command === 'gcc' ? '/usr/lib/gcc/x86_64-alpine-linux-musl/14/libstdc++.a\n' : undefined;
  }
}

describe('srt', () => {
  // SRT_ENCLIB=mbedtls when deps/lib/libmbedcrypto.a exists, else off; cmake_build SRT_ARGS (+ the encryption arguments,
  // + -DCMAKE_FIND_ROOT_PATH on android with mbedtls); then with mbedtls: a libsrt*.a holding "haicrypt", the .a paths
  // dropped and "Libs.private: <mbed libs>" prepended (-lbcrypt on win-*); win-*|linux-musl-*: -lgcc_s stripped;
  // ${CXX_RT} at the end of Libs.private unless already there.
  const installed = (h: Harness) =>
    `Libs: -L\${libdir} -lsrt\nLibs.private: ${h.deps}/lib/libmbedtls.a ${h.deps}/lib/libmbedx509.a ${h.deps}/lib/libmbedcrypto.a -lstdc++ -lgcc_s -lgcc -lc -lgcc_s\n`;
  for (const mbedtls of [true, false]) {
    it.each(platformsOf('srt'))(`%s ${mbedtls ? 'with' : 'without'} mbedTLS`, async (platform) => {
      const h = fake(platform);
      if (mbedtls) {
        put(join(h.deps, 'lib', 'libmbedcrypto.a'));
      }
      put(join(h.deps, 'lib', 'libsrt.a'), '!<arch>\nHaiCrypt_Create');
      writeFileSync(pcPath(h, 'srt'), installed(h));
      await build(h, 'srt');
      const encryption = mbedtls
        ? [
            '-DENABLE_ENCRYPTION=ON',
            '-DUSE_ENCLIB=mbedtls',
            ...(platform.startsWith('android-') ? [`-DCMAKE_FIND_ROOT_PATH=${h.deps}`] : []),
          ]
        : ['-DENABLE_ENCRYPTION=OFF'];
      expect(commands(h)).toEqual(
        cmakeLines(h, [
          '-DENABLE_APPS=OFF',
          '-DENABLE_SHARED=OFF',
          '-DENABLE_STATIC=ON',
          ...encryption,
        ]),
      );
      let pc = installed(h);
      if (mbedtls) {
        pc = pc
          .replace(/[^\s]*\/libmbed(tls|x509|crypto)\.a/g, '')
          .replace(
            /^Libs\.private:/m,
            `Libs.private: -lmbedtls -lmbedx509 -lmbedcrypto${platform.startsWith('win-') ? ' -lbcrypt' : ''}`,
          );
      }
      if (/^(win|linux-musl)-/.test(platform)) {
        pc = pc.replaceAll(' -lgcc_s ', ' ').replace(/ -lgcc_s$/m, '');
      }
      const line = pc.match(/^Libs\.private:.*$/m)![0];
      if (!line.split(/\s+/).includes(cxxRt(platform))) {
        pc = pc.replace(line, `${line} ${cxxRt(platform)}`);
      }
      expect(h.read(pcPath(h, 'srt'))).toBe(pc);
    });
  }
  it('fails when the encryption layer is not in the archive', async () => {
    const h = fake('linux-x64');
    put(join(h.deps, 'lib', 'libmbedcrypto.a'));
    put(join(h.deps, 'lib', 'libsrt.a'), '!<arch>\n');
    writeFileSync(pcPath(h, 'srt'), 'Libs.private: -lm\n');
    await expect(build(h, 'srt')).rejects.toThrow(/HaiCrypt layer is not in the archive/);
    rmSync(join(h.deps, 'lib', 'libsrt.a'));
    await expect(build(h, 'srt')).rejects.toThrow(/no libsrt\*\.a found/);
  });
});

describe('librist', () => {
  // RIST_CRYPTO=mbedtls when deps/lib/libmbedcrypto.a exists; meson setup _build --prefix --libdir=lib
  // --default-library=static --buildtype=release ${MESON_CROSS_ARGS} RIST_ARGS (base, crypto, win-*: mingw pthreads);
  // meson compile; with mbedtls no _build/**/libmbedcrypto.a; meson install; with mbedtls: the .a paths dropped and
  // the mbedTLS -l libs (+ -lbcrypt on win-*) at the end of Libs.private, or a new line.
  const installed = (h: Harness) =>
    `Libs: -L\${libdir} -lrist\nLibs.private: -lpthread ${h.deps}/lib/libeverest.a ${h.deps}/lib/libmbedcrypto.a ${h.deps}/lib/libp256m.a\n`;
  for (const mbedtls of [true, false]) {
    it.each(platformsOf('librist'))(
      `%s ${mbedtls ? 'with' : 'without'} mbedTLS`,
      async (platform) => {
        const h = fake(platform);
        if (mbedtls) {
          put(join(h.deps, 'lib', 'libmbedcrypto.a'));
        }
        writeFileSync(pcPath(h, 'librist'), installed(h));
        await build(h, 'librist');
        const crypto = mbedtls
          ? ['-Duse_mbedtls=true', '-Duse_gnutls=false', `-Dcmake_prefix_path=${h.deps}`]
          : ['-Duse_mbedtls=false', '-Duse_gnutls=false'];
        expect(commands(h)).toEqual([
          [
            'meson',
            'setup',
            '_build',
            `--prefix=${h.deps}`,
            '--libdir=lib',
            '--default-library=static',
            '--buildtype=release',
            ...h.context.toolchain.mesonArgs,
            '-Dbuilt_tools=false',
            '-Dtest=false',
            '-Dbuiltin_cjson=true',
            '-Dbuiltin_lz4=true',
            '-Dbuiltin_mbedtls=false',
            ...crypto,
            ...(platform.startsWith('win-') ? ['-Dhave_mingw_pthreads=true'] : []),
          ].join(' '),
          'meson compile -C _build -j 4',
          'meson install -C _build',
        ]);
        const mbed = `-lmbedtls -lmbedx509 -lmbedcrypto${platform.startsWith('win-') ? ' -lbcrypt' : ''}`;
        expect(h.read(pcPath(h, 'librist'))).toBe(
          mbedtls
            ? installed(h)
                .replace(/[^\s]*\/lib(mbedtls|mbedx509|mbedcrypto|everest|p256m)\.a/g, '')
                .replace(/^Libs\.private:.*$/m, `$& ${mbed}`)
            : installed(h),
        );
      },
    );
  }
  it('fails when librist built its vendored mbedTLS', async () => {
    const h = fake('win-arm64');
    put(join(h.deps, 'lib', 'libmbedcrypto.a'));
    put(join(h.src, '_build', 'contrib', 'mbedtls', 'libmbedcrypto.a'));
    await expect(build(h, 'librist')).rejects.toThrow(/fell back to its VENDORED mbedTLS/);
  });
});

describe('whisper.cpp', () => {
  // The case statements of the old step, per platform: the backend, the cmake arguments after WHISPER_CMAKE's base list,
  // and WHISPER_SYS_LIBS.
  const base = [
    '-DGGML_NATIVE=OFF',
    '-DGGML_OPENMP=OFF',
    '-DWHISPER_BUILD_EXAMPLES=OFF',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=OFF',
    '-DGGML_BUILD_TESTS=OFF',
    '-DGGML_BUILD_EXAMPLES=OFF',
  ];
  function expected(h: Harness, loader: boolean): { backend: string; args: string[]; sys: string } {
    const p = h.platform;
    const d = h.deps;
    const spirv = `${d}/share/cmake/SPIRV-Headers`;
    const vk = [
      '-DGGML_VULKAN=ON',
      '-DGGML_CPU=ON',
      `-DVulkan_INCLUDE_DIR=${d}/include`,
      `-DSPIRV-Headers_DIR=${spirv}`,
    ];
    const release =
      p === 'win-x64'
        ? ['-DCMAKE_C_FLAGS_RELEASE=-O3 -DNDEBUG -g', '-DCMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG -g']
        : [];
    const compat = p.startsWith('win-')
      ? [
          `-DCMAKE_C_FLAGS=-include ${h.src}/win_ggml_compat.h`,
          `-DCMAKE_CXX_FLAGS=-include ${h.src}/win_ggml_compat.h`,
        ]
      : [];
    const cxxStatic = p.startsWith('linux-musl-') ? '-l:libstdc++.a' : '-lstdc++';
    let cpuSys = `${cxxStatic} -lm -lpthread`;
    if (p.startsWith('android-')) {
      cpuSys = '-lc++ -lm';
    } else if (p === 'win-arm64') {
      cpuSys = '-l:libc++.a -lm';
    }
    const cpu = { backend: 'cpu', args: [...release, '-DGGML_CPU=ON', ...compat], sys: cpuSys };
    if (/^(osx|ios|maccatalyst)-/.test(p)) {
      return {
        backend: 'metal',
        args: [
          '-DGGML_BLAS_VENDOR=Apple',
          '-DGGML_METAL=ON',
          '-DGGML_METAL_EMBED_LIBRARY=ON',
          '-DGGML_CPU=ON',
        ],
        sys: '-lc++ -lm -framework Foundation -framework Metal -framework MetalKit -framework Accelerate',
      };
    }
    if (p.startsWith('android-')) {
      return {
        backend: 'vulkan',
        args: [
          ...vk,
          `-DVulkan_LIBRARY=${env(h, 'TOOLCHAIN')}/sysroot/usr/lib/${env(h, 'ANDROID_TRIPLE')}/28/libvulkan.so`,
        ],
        sys: '-lvulkan -lc++ -lm',
      };
    }
    if (p === 'linux-armhf' || !loader) {
      return cpu;
    }
    if (p.startsWith('win-')) {
      const shim = `${d}/lib/libvulkan-1.a`;
      return {
        backend: 'vulkan',
        args: [...release, ...vk, `-DVulkan_LIBRARY=${shim}`, ...compat],
        sys: `-l:libvulkan-1.a ${p === 'win-arm64' ? '-l:libc++.a' : '-lstdc++'} -lm`,
      };
    }
    if (p.startsWith('linux-musl-')) {
      return { backend: 'vulkan', args: vk, sys: '-lvulkan -l:libstdc++.a -lm -lpthread' };
    }
    return {
      backend: 'vulkan',
      args: [...vk, `-DVulkan_INCLUDE_DIR=${d}/include`, `-DVulkan_LIBRARY=${d}/lib/libvulkan.so`],
      sys: '-lvulkan -lstdc++ -lm -lpthread',
    };
  }
  const COMPAT =
    '#ifndef WHISPER_WIN_GGML_COMPAT_H\n#define WHISPER_WIN_GGML_COMPAT_H\n#include <windows.h>\n#ifndef THREAD_POWER_THROTTLING_CURRENT_VERSION\ntypedef struct _THREAD_POWER_THROTTLING_STATE {\n    ULONG Version; ULONG ControlMask; ULONG StateMask;\n} THREAD_POWER_THROTTLING_STATE, *PTHREAD_POWER_THROTTLING_STATE;\n#define THREAD_POWER_THROTTLING_CURRENT_VERSION 1\n#define THREAD_POWER_THROTTLING_EXECUTION_SPEED 0x1\n#define THREAD_POWER_THROTTLING_VALID_FLAGS THREAD_POWER_THROTTLING_EXECUTION_SPEED\n#endif\n#endif\n';

  // the -l flags and archives each GPU backend adds beside the CPU ones
  const backendFlags: Record<string, string[]> = {
    metal: ['-lggml-metal', '-lggml-blas'],
    vulkan: ['-lggml-vulkan'],
    cpu: [],
  };
  const backendArchives: Record<string, string[]> = {
    metal: ['libggml-blas.a', 'libggml-metal.a'],
    vulkan: ['libggml-vulkan.a'],
    cpu: [],
  };
  for (const [loader, variant] of [
    [true, 'with'],
    [false, 'without'],
  ] as const) {
    it.each(platformsOf('whisper.cpp'))(
      `%s ${variant} the Vulkan loader/shim`,
      async (platform) => {
        const h = fake(platform);
        const want = expected(h, loader);
        seedWhisper(h, platform, loader, want.backend);
        await build(h, 'whisper.cpp');
        expect(commands(h)).toEqual([
          ...(platform.startsWith('linux-musl-') ? ['gcc -print-file-name=libstdc++.a'] : []),
          ...cmakeLines(h, [...base, ...want.args]),
        ]);
        const ggml = ['-lggml', '-lggml-cpu', ...backendFlags[want.backend]!, '-lggml-base'].join(
          ' ',
        );
        expect(h.read(pcPath(h, 'whisper'))).toBe(
          `prefix=${h.deps}\nlibdir=\${prefix}/lib\nincludedir=\${prefix}/include\n\nName: whisper\nDescription: whisper.cpp speech recognition\nVersion: 1.2.3\nLibs: -L\${libdir} -lwhisper\nLibs.private: ${ggml} ${want.sys}\nCflags: -I\${includedir}\n`,
        );
        expect(h.files(join(h.deps, 'lib')).filter((f) => f.includes('ggml'))).toEqual(
          [
            'libggml-base.a',
            'libggml-cpu.a',
            ...backendArchives[want.backend]!,
            'libggml.a',
          ].sort(),
        );
        // only Windows gets the compat header
        const compatHeader = join(h.src, 'win_ggml_compat.h');
        expect(existsSync(compatHeader) ? h.read(compatHeader) : undefined).toBe(
          platform.startsWith('win-') ? COMPAT : undefined,
        );
      },
    );
  }

  it('fails when the requested GPU backend fell back to the CPU, or there is no CPU archive', async () => {
    const h = fake('android-arm64');
    put(join(h.deps, 'include', 'vulkan', 'vulkan.h'));
    put(join(h.deps, 'lib', 'libggml-cpu.a'));
    await expect(build(h, 'whisper.cpp')).rejects.toThrow(
      /requested the vulkan ggml backend on android-arm64/,
    );
    const cpu = fake('linux-armhf');
    await expect(build(cpu, 'whisper.cpp')).rejects.toThrow(/libggml-cpu.a missing/);
  });
  it('fails without the Vulkan headers, or without libstdc++.a on musl', async () => {
    const h = fake('android-x64');
    await expect(build(h, 'whisper.cpp')).rejects.toThrow(/whisper needs Vulkan-Headers/);
    const musl = fake('linux-musl-x64');
    musl.onRun = () => 'libstdc++.a\n'; // gcc prints the bare name when it has no such file
    await expect(build(musl, 'whisper.cpp')).rejects.toThrow(
      /libstdc\+\+\.a not found on this musl toolchain/,
    );
  });
});
