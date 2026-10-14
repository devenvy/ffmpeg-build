import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  acquireBuildLock,
  hostEnv,
  nativeEnv,
  nativePaths,
  nativeWorkRoot,
} from '../src/build/native.ts';

describe('native builds', () => {
  it('keep each platform in its own folders under the work root', () => {
    const p = nativePaths('/Users/me/ffmpeg-build-work', 'osx-arm64');
    expect(p).toEqual({
      depsDir: '/Users/me/ffmpeg-build-work/deps/osx-arm64',
      work: '/Users/me/ffmpeg-build-work/work/osx-arm64',
    });
  });

  it('gives the Node worker every path through the environment', () => {
    const env = nativeEnv({
      plan: '/t/plan.json',
      recipes: '/e/recipes',
      engine: '/e/platforms',
      cache: '/c',
      out: '/o',
      depsDir: '/w/deps/osx-arm64',
      work: '/w/work/osx-arm64',
    });
    expect(env).toMatchObject({
      FFB_PLAN: '/t/plan.json',
      FFB_RECIPES: '/e/recipes',
      ENGINE: '/e/platforms',
      FFB_CACHE: '/c',
      FFB_OUT: '/o',
      DEPS_DIR: '/w/deps/osx-arm64',
      FFB_WORK: '/w/work/osx-arm64',
    });
  });
});

describe('native builds on a user machine', () => {
  it('pass the build only the host environment it needs, never compiler or search-path variables', () => {
    const env = hostEnv(
      {
        HOME: '/Users/me',
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C',
        TMPDIR: '/tmp/x',
        HOMEBREW_PREFIX: '/opt/homebrew',
        CC: 'gcc-14',
        CXX: 'g++-14',
        CPATH: '/opt/homebrew/include',
        LIBRARY_PATH: '/opt/homebrew/lib',
        CMAKE_PREFIX_PATH: '/opt/homebrew',
        MAKEFLAGS: '-j1',
        SDKROOT: '/x',
        CFLAGS: '-O0',
      },
      'darwin',
    );
    expect(Object.keys(env).sort()).toEqual([
      'HOME',
      'HOMEBREW_PREFIX',
      'LANG',
      'LC_ALL',
      'PATH',
      'TMPDIR',
    ]);
  });

  it('puts Homebrew first on PATH for build tools and recipe shell steps', () => {
    expect(
      hostEnv({ PATH: '/usr/bin:/bin', HOMEBREW_PREFIX: '/opt/homebrew' }, 'darwin')['PATH'],
    ).toBe('/opt/homebrew/bin:/usr/bin:/bin');
    expect(hostEnv({ PATH: '/usr/bin' }, 'darwin')['PATH']).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('use an absolute work folder without spaces', () => {
    const before = process.env['FFMPEG_BUILD_WORK'];
    try {
      process.env['FFMPEG_BUILD_WORK'] = '';
      expect(nativeWorkRoot()).toMatch(/ffmpeg-build-work$/);
      process.env['FFMPEG_BUILD_WORK'] = 'relative/work';
      expect(nativeWorkRoot()).toBe(join(process.cwd(), 'relative', 'work'));
      process.env['FFMPEG_BUILD_WORK'] = '/Users/me/My Builds';
      expect(() => nativeWorkRoot()).toThrow(/space/);
    } finally {
      if (before === undefined) {
        delete process.env['FFMPEG_BUILD_WORK'];
      } else {
        process.env['FFMPEG_BUILD_WORK'] = before;
      }
    }
  });

  it('build one platform at a time on a machine, and take over a lock whose build is gone', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-lock-'));
    const release = acquireBuildLock(root, 'osx-arm64');
    expect(() => acquireBuildLock(root, 'osx-arm64')).toThrow(/already building osx-arm64/);
    const other = acquireBuildLock(root, 'ios-arm64'); // another platform is fine
    other();
    release();
    acquireBuildLock(root, 'osx-arm64')(); // free again
    writeFileSync(join(root, 'osx-arm64.lock'), '999999999\n'); // a build that died without releasing
    acquireBuildLock(root, 'osx-arm64')();
  });
});
