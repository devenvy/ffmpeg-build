// The toolchain of a native build (--in here) on Linux and in MSYS2: the platform's own compilers, not a cross toolchain.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { msys2 } from './helpers.ts';
import { beforeFfmpeg, createToolchain, msys2WinpthreadsNotice } from '../src/build/toolchain.ts';

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
});
