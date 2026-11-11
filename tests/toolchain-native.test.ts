// The toolchain of a native build (--in here) on Linux and in MSYS2: the platform's own compilers, not a cross toolchain.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { beforeFfmpeg, createToolchain, msys2WinpthreadsNotice } from '../src/build/toolchain.ts';
import { msys2 } from './helpers.ts';

const dirs = () => {
  const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-native-tc-')).replaceAll('\\', '/');
  return { depsDir: `${root}/deps`, work: `${root}/work`, engine: root };
};

describe('native toolchains', () => {
  it('Linux: the same flags as the image, without the image compiler paths', () => {
    const docker = createToolchain({
      platform: 'linux-x64',
      setup: 'linux',
      ...dirs(),
      env: { PATH: '/usr/bin' },
    });
    const here = createToolchain({
      platform: 'linux-x64',
      setup: 'linux',
      native: true,
      ...dirs(),
      env: { PATH: '/usr/bin' },
    });
    expect(docker.env['PATH']).toContain('gcc-toolset-14');
    expect(here.env['PATH']).toBe('/usr/bin');
    expect(here.env['PCP_DIR']).toBeUndefined();
    expect([here.env['CFLAGS'], here.env['CXXFLAGS']]).toEqual(['-fPIC', '-fPIC']);
    expect([here.cmakeArgs, here.mesonArgs]).toEqual([[], []]);
  });

  it('Windows in MSYS2: the MinGW compilers by their plain names, no cross files, cmake on Ninja', () => {
    const x64 = createToolchain({
      platform: 'win-x64',
      setup: 'windows',
      native: true,
      ...dirs(),
      ...msys2(),
    });
    expect(x64.env).toMatchObject({
      CC: 'gcc',
      CXX: 'g++',
      AR: 'ar',
      RANLIB: 'ranlib',
      NM: 'nm',
      STRIP: 'strip',
      DLLTOOL_MACHINE: 'i386:x86-64',
    });
    expect(x64.env['CROSS_HOST']).toBeUndefined();
    expect(x64.env['CROSS_PREFIX']).toBeUndefined();
    expect(x64.cmakeArgs).toEqual(['-G', 'Ninja']);
    expect(x64.mesonArgs).toEqual([]);
    const arm = createToolchain({
      platform: 'win-arm64',
      setup: 'windows',
      native: true,
      ...dirs(),
      ...msys2(),
    });
    expect(arm.env).toMatchObject({
      CC: 'clang',
      CXX: 'clang++',
      DLLTOOL_MACHINE: 'arm64',
      CXX_RT_LIB: '-l:libc++.a',
    });
  });

  it("Windows in MSYS2: FFmpeg's configure gets no cross-compile flags", () => {
    const d = dirs();
    const tc = createToolchain({
      platform: 'win-x64',
      setup: 'windows',
      native: true,
      ...d,
      ...msys2(),
    });
    const flags = [
      '--enable-w32threads',
      '--target-os=mingw32',
      '--enable-cross-compile',
      '--arch=x86_64',
      '--cross-prefix=x86_64-w64-mingw32-',
      '--cc=x86_64-w64-mingw32-gcc-win32',
      '--cxx=x86_64-w64-mingw32-g++-win32',
      '--enable-libdav1d',
    ];
    expect(
      beforeFfmpeg(
        {
          buildPlan: { platform: 'win-x64', setup: 'windows' },
          depsDir: d.depsDir,
          env: { ...tc.env, FFB_IN: 'here' },
        },
        d.work,
        flags,
      ),
    ).toEqual([
      '--enable-w32threads',
      '--target-os=mingw32',
      '--arch=x86_64',
      '--enable-libdav1d',
      '--extra-ldflags=-static',
      '--extra-ldflags=-l:CRT_fp10.o',
    ]);
    // in the image, unchanged
    expect(
      beforeFfmpeg(
        { buildPlan: { platform: 'win-x64', setup: 'windows' }, depsDir: d.depsDir, env: {} },
        d.work,
        flags,
      ),
    ).toEqual(flags);
  });

  it.each(['clang', 'clang++'])(
    'keeps native x64 Clang on its own floating-point runtime (%s)',
    (cc) => {
      const d = dirs();
      const flags = beforeFfmpeg(
        {
          buildPlan: { platform: 'win-x64', setup: 'windows' },
          depsDir: d.depsDir,
          env: { FFB_IN: 'here', CC: cc },
        },
        d.work,
        [],
      );
      expect(flags).toEqual(['--extra-ldflags=-static']);
    },
  );

  it("finds winpthreads' licence in the MSYS2 environment for the notices, and says where it looked when it can't", () => {
    const m = msys2();
    expect(
      createToolchain({ platform: 'win-x64', setup: 'windows', native: true, ...dirs(), ...m }).env[
        'WINPTHREADS_NOTICE'
      ],
    ).toBe(m.notice);
    expect(() => msys2WinpthreadsNotice({ MINGW_PREFIX: '/mingw64' }, () => 'Z:/nowhere')).toThrow(
      'no winpthreads licence under Z:/nowhere/share/licenses',
    );
    expect(() => msys2WinpthreadsNotice({}, () => '')).toThrow('MINGW_PREFIX is not set');
    // in the image, the image's copy
    expect(
      createToolchain({ platform: 'win-x64', setup: 'windows', ...dirs(), env: {} }).env[
        'WINPTHREADS_NOTICE'
      ],
    ).toBe('/usr/share/doc/mingw-w64-x86-64-dev/copyright');
  });

  it("names the compiler runtimes' licences, for the ships: entries a build links in, as each toolchain has them", () => {
    const m = msys2();
    const licenses = m.notice.replace(/\/winpthreads\/COPYING$/, '');
    for (const path of [
      'gcc/COPYING.RUNTIME',
      'gcc/COPYING3',
      'libc++/LICENSE',
      'compiler-rt/LICENSE',
      'crt/COPYING.MinGW-w64-runtime.txt',
    ]) {
      mkdirSync(`${licenses}/${path.replace(/\/[^/]+$/, '')}`, { recursive: true });
      writeFileSync(`${licenses}/${path}`, path);
    }
    const native = createToolchain({
      platform: 'win-x64',
      setup: 'windows',
      native: true,
      ...dirs(),
      ...m,
    }).env;
    expect(native).toMatchObject({
      LIBSTDCXX_NOTICE: `${licenses}/gcc/COPYING.RUNTIME`,
      LIBGCC_NOTICE: `${licenses}/gcc/COPYING.RUNTIME`,
      GCC_GPL3: `${licenses}/gcc/COPYING3`,
      LIBCXX_NOTICE: `${licenses}/libc++/LICENSE`,
      COMPILER_RT_NOTICE: `${licenses}/compiler-rt/LICENSE`,
      MINGW_CRT_NOTICE: `${licenses}/crt/COPYING.MinGW-w64-runtime.txt`,
      COMPILER_RUNTIMES: 'libstdc++ libgcc',
    });
    // CLANG64: compiler-rt is built with clang; MSYS2's libc++ and libunwind are packages of their own
    expect(
      createToolchain({
        platform: 'win-x64',
        setup: 'windows',
        native: true,
        ...dirs(),
        ...msys2({ MSYSTEM: 'CLANG64' }),
      }).env,
    ).toMatchObject({
      CC: 'clang',
      CXX_RT_LIB: '-l:libc++.a',
      COMPILER_RUNTIMES: 'compiler-rt-builtins',
    });
    // what the environment doesn't have stays unset: a build that links it in fails at its notices, naming it
    expect(native['LIBUNWIND_NOTICE']).toBeUndefined();
    const image = (platform: string) =>
      createToolchain({ platform, setup: 'windows', ...dirs(), env: {} }).env;
    expect(image('win-x64')).toMatchObject({
      LIBSTDCXX_NOTICE: '/usr/share/doc/g++-mingw-w64-x86-64-win32/copyright',
      LIBGCC_NOTICE: '/usr/share/doc/gcc-mingw-w64-x86-64-win32/copyright',
      GCC_GPL3: '/usr/share/common-licenses/GPL-3',
      MINGW_CRT_NOTICE: '/usr/share/doc/mingw-w64-x86-64-dev/copyright',
      COMPILER_RUNTIMES: 'libstdc++ libgcc',
    });
    expect(image('win-arm64')).toMatchObject({
      LIBCXX_NOTICE: '/opt/llvm-mingw/LICENSE.TXT',
      LIBUNWIND_NOTICE: '/opt/llvm-mingw/LICENSE.TXT',
      COMPILER_RT_NOTICE: '/opt/llvm-mingw/LICENSE.TXT',
      MINGW_CRT_NOTICE:
        '/opt/llvm-mingw/aarch64-w64-mingw32/share/mingw32/COPYING.MinGW-w64-runtime.txt',
      COMPILER_RUNTIMES: 'libc++ libunwind compiler-rt-builtins',
    });
    const linux = (setup: string, platform: string) =>
      createToolchain({ platform, setup, ...dirs(), env: {} }).env['COMPILER_RUNTIMES'];
    expect(linux('linux', 'linux-x64')).toBe('libgcc libstdc++_nonshared');
    expect(linux('linux-musl', 'linux-musl-x64')).toBe('libstdc++ libgcc');
    expect(linux('linux-armhf', 'linux-armhf')).toBe('libgcc');
    // the NDK's compiler-rt builtins and libunwind come with its clang
    expect(
      createToolchain({
        platform: 'android-arm64',
        setup: 'android',
        ...dirs(),
        env: { ANDROID_NDK_HOME: '/ndk' },
      }).env['COMPILER_RUNTIMES'],
    ).toBe('compiler-rt-builtins libunwind');
    // glibc's static parts' notices, as each image's packages install them
    expect(
      createToolchain({ platform: 'linux-x64', setup: 'linux', ...dirs(), env: {} }).env,
    ).toMatchObject({
      GLIBC_LGPL: '/usr/share/licenses/glibc/COPYING.LIB',
      GLIBC_NOTICE: '/usr/share/licenses/glibc/LICENSES',
    });
    expect(
      createToolchain({ platform: 'linux-armhf', setup: 'linux-armhf', ...dirs(), env: {} }).env,
    ).toMatchObject({
      GLIBC_LGPL: '/usr/share/common-licenses/LGPL-2.1',
      GLIBC_NOTICE: '/usr/share/doc/libc6-dev-armhf-cross/copyright',
    });
    expect(image('win-arm64')['LIBSTDCXX_NOTICE']).toBeUndefined();
  });
});
