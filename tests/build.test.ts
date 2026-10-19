import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureData, fixtureEngineRoot, fixtureProfilesDir, writeEngine } from './helpers.ts';
import {
  containerCleanup,
  dockerRunArgs,
  hostUserOf,
  imageTag,
  mountArgs,
  runStreaming,
} from '../src/build/docker.ts';
import {
  cacheKeys,
  configureFlags,
  expandTemplate,
  makeBuildPlan,
  sourceOf,
  toolchainIdentity,
  verifyNames,
} from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { loadProfile, parseProfileText, type Profile } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

import type { LockedProfile } from '../src/lockfile.ts';

const data = fixtureData();
const studio = (() => {
  const r = loadProfile(join(fixtureProfilesDir, 'studio.yml'));
  if (!r.ok) {
    throw new Error('studio.yml');
  }
  return r.profile;
})();
const studioLock: LockedProfile = {
  ffmpeg: { '9': '9.1.0' },
  libraries: {
    dav1d: '1.5.4',
    libdrm: '2.4.134',
    libva: '2.24.1',
    mbedtls: '3.6.5',
    'nv-codec': '13.0.19.1',
    opus: '1.6.1',
    srt: '1.5.8',
  },
  pinned: [],
};
const linuxCell = (parsed: Profile, locked: LockedProfile) =>
  planProfile(parsed, data, locked.ffmpeg).cells.find((c) => c.cell.platform === 'linux-x64')!;
function profile(text: string): Profile {
  const r = parseProfileText(text, 't.yml');
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return r.profile;
}

describe('sources', () => {
  it('fills version templates', () => {
    expect(
      expandTemplate('https://x/gnutls/v{major}.{minor}/gnutls-{version}.tar.xz', '3.8.13'),
    ).toBe('https://x/gnutls/v3.8/gnutls-3.8.13.tar.xz');
    expect(expandTemplate('n{version}-{patch}', '9.0')).toBe('n9.0-');
  });

  it('gives a git ref, a commit, or tarball urls', () => {
    expect(sourceOf(data, 'nv-codec', '13.0.19.1')).toEqual({
      git: 'https://github.com/FFmpeg/nv-codec-headers',
      ref: 'n13.0.19.1',
    });
    expect(sourceOf(data, 'gnutls', '3.8.13')).toEqual({
      archives: ['https://www.gnupg.org/ftp/gcrypt/gnutls/v3.8/gnutls-3.8.13.tar.xz'],
    });
    const engine = loadEngineData(
      writeEngine({
        'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  x264: { needs: x264 }\n',
        'recipes/x264/recipe.yml':
          'name: x264\nlicense: GPL-2.0-or-later\nsource: { git: https://example.com/x264, mirror: https://example.org/x264 }\nversions: { git-branch: stable }\nplatforms: all\n',
      }),
    );
    const commit = 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55';
    expect(sourceOf(engine, 'x264', commit)).toEqual({
      git: 'https://example.com/x264',
      commit,
      mirror: 'https://example.org/x264',
    });
  });
});

describe('FFmpeg configure', () => {
  it('has the base flags, the license flags and each option recipe flags', () => {
    const flags = configureFlags(data, linuxCell(studio, studioLock));
    expect(flags.slice(0, 2)).toEqual(['--enable-shared', '--disable-static']);
    expect(flags).toContain('--enable-ffmpeg'); // from platforms.yml
    expect(flags).toContain('--enable-ffprobe');
    expect(flags).toContain('--disable-autodetect');
    expect(flags).toContain('--pkg-config-flags=--static');
    expect(flags).toContain('--extra-cflags=-I/opt/ffmpeg-build/deps/include');
    expect(flags).toContain('--extra-libs=-lpthread -ldl');
    for (const f of [
      '--enable-gpl',
      '--enable-version3',
      '--enable-nonfree',
      '--enable-libdav1d',
      '--enable-ffnvcodec',
      '--enable-libsrt',
      '--enable-libopus',
      '--enable-vaapi',
    ]) {
      expect(flags).toContain(f);
    }
    expect(flags.filter((f) => f === '--enable-gpl')).toHaveLength(1);
  });

  it('enables a built-in option by its name', () => {
    const p = profile(
      'name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv3\nwith: [whep]\n',
    );
    const cell = planProfile(p, data, { '9': '9.1.0' }).cells[0]!;
    expect(configureFlags(data, cell)).toContain('--enable-whep');
    expect(configureFlags(data, cell)).toContain('--enable-version3');
    expect(configureFlags(data, cell)).not.toContain('--enable-gpl');
    expect(configureFlags(data, cell)).toContain('--disable-gpl');
    expect(configureFlags(data, cell)).toContain('--disable-nonfree');
  });

  it("names what to verify in FFmpeg's config.mak", () => {
    expect(verifyNames(data, linuxCell(studio, studioLock))).toEqual([
      'LIBDAV1D',
      'FFNVCODEC',
      'NVENC',
      'NVDEC',
      'CUVID',
      'LIBOPUS',
      'LIBSRT',
      'VAAPI',
    ]);
  });
});

describe('cache keys', () => {
  const versions: Record<string, string> = { libdrm: '2.4.134', libva: '2.24.1', dav1d: '1.5.4' };
  const keys = (d = data, v = versions) =>
    cacheKeys(d, ['dav1d', 'libdrm', 'libva'], (r) => v[r]!, 'linux-x64', 'abc123');

  it('are stable', () => {
    expect(keys()).toEqual(keys());
    expect(keys().get('dav1d')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('change for a dependent when its dependency changes', () => {
    const changed = keys(data, { ...versions, libdrm: '2.4.135' });
    expect(changed.get('libdrm')).not.toBe(keys().get('libdrm'));
    expect(changed.get('libva')).not.toBe(keys().get('libva')); // libva needs libdrm
    expect(changed.get('dav1d')).toBe(keys().get('dav1d'));
  });

  it('change for a library and its dependents when its pinned source changes at the same version', () => {
    const pinned = (pins: Record<string, { commit?: string; sha256?: string }>) =>
      cacheKeys(
        data,
        ['dav1d', 'libdrm', 'libva'],
        (r) => versions[r]!,
        'linux-x64',
        'abc123',
        (r) => pins[r],
      );
    const before = pinned({ libdrm: { commit: 'a'.repeat(40) } });
    // upstream moved the tag: same version, another commit
    const moved = pinned({ libdrm: { commit: 'b'.repeat(40) } });
    expect(moved.get('libdrm')).not.toBe(before.get('libdrm'));
    expect(moved.get('libva')).not.toBe(before.get('libva')); // libva needs libdrm
    expect(moved.get('dav1d')).toBe(before.get('dav1d'));
    // an archive's pin counts the same way
    expect(pinned({ dav1d: { sha256: 'c'.repeat(64) } }).get('dav1d')).not.toBe(
      pinned({ dav1d: { sha256: 'd'.repeat(64) } }).get('dav1d'),
    );
    // no pins at all: the keys a lock without pins always had
    expect(pinned({})).toEqual(keys());
  });

  it("change for a library's licence files, but not for what builds against it", () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-keys-'));
    cpSync(fixtureEngineRoot, root, { recursive: true });
    const yml = join(root, 'recipes', 'libdrm', 'recipe.yml');
    writeFileSync(
      yml,
      readFileSync(yml, 'utf8').replace(
        'license-files: [COPYING]',
        'license-files: [COPYING, { recipe: NOTICE }]',
      ),
    );
    writeFileSync(join(root, 'recipes', 'libdrm', 'NOTICE'), 'kept beside the recipe\n');
    const edited = loadEngineData(root);
    expect(keys(edited).get('libdrm')).not.toBe(keys().get('libdrm'));
    expect(keys(edited).get('libva')).toBe(keys().get('libva')); // libva needs libdrm
    const before = keys(edited).get('libdrm'); // keys read the files when they're computed
    writeFileSync(join(root, 'recipes', 'libdrm', 'NOTICE'), 'changed\n');
    expect(keys(loadEngineData(root)).get('libdrm')).not.toBe(before);
    expect(keys(loadEngineData(root)).get('libva')).toBe(keys().get('libva'));
    writeFileSync(join(root, 'recipes', 'libdrm', 'TUNING'), 'changed\n');
    expect(keys(loadEngineData(root)).get('libva')).not.toBe(keys().get('libva')); // anything else still counts
  });

  it('leave out licence files written as a wrapped list (as Prettier writes a long one)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-keys-'));
    cpSync(fixtureEngineRoot, root, { recursive: true });
    const yml = join(root, 'recipes', 'libdrm', 'recipe.yml');
    const wrapped = (files: string[]): void => {
      writeFileSync(
        yml,
        readFileSync(yml, 'utf8').replace(
          /^license-files:[^\]]*\]/m,
          `license-files:\n  [\n${files.map((f) => `    ${f},`).join('\n')}\n  ]`,
        ),
      );
    };
    wrapped(['COPYING', 'COPYING.MIT']);
    const before = keys(loadEngineData(root)).get('libva');
    wrapped(['COPYING', 'COPYING.MIT', 'NOTICE']);
    expect(keys(loadEngineData(root)).get('libva')).toBe(before); // libva needs libdrm
  });

  it('change when a recipe file changes, or the platform or image does', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-keys-'));
    cpSync(fixtureEngineRoot, root, { recursive: true });
    const dav1d = join(root, 'recipes', 'dav1d', 'recipe.yml');
    writeFileSync(
      dav1d,
      readFileSync(dav1d, 'utf8').replace("steps: [['true']]", "steps: [['echo', 'changed']]"),
    );
    const edited = loadEngineData(root);
    expect(keys(edited).get('dav1d')).not.toBe(keys().get('dav1d'));
    expect(keys(edited).get('libdrm')).toBe(keys().get('libdrm'));
    expect(
      cacheKeys(data, ['dav1d'], () => '1.5.4', 'linux-arm64', 'abc123').get('dav1d'),
    ).not.toBe(keys().get('dav1d'));
    expect(cacheKeys(data, ['dav1d'], () => '1.5.4', 'linux-x64', 'def456').get('dav1d')).not.toBe(
      keys().get('dav1d'),
    );
  });
});

describe('the build plan', () => {
  it("names an FFmpeg x.y build's sources archive as its release does: three parts (ffmpeg-9.1.0-sources)", () => {
    const lock = { ...studioLock, ffmpeg: { '9': '9.1' } };
    const plan = makeBuildPlan({
      profile: studio,
      data,
      locked: lock,
      cell: linuxCell(studio, lock),
      variant: 'studio',
      imageId: 'img',
      cacheDir: mkdtempSync(join(tmpdir(), 'ffmpeg-build-cache-')),
    });
    expect(plan.sourcesArchive).toBe('ffmpeg-9.1.0-sources.tar.gz');
    expect(plan.name).toBe('ffmpeg-9.1.0-linux-x64-studio');
    expect(plan.ffmpeg!.archives[0]).toBe('https://ffmpeg.org/releases/ffmpeg-9.1.tar.xz'); // upstream's own name
  });

  it('lists libraries in build order with their exact versions, keys and sources', () => {
    const cache = mkdtempSync(join(tmpdir(), 'ffmpeg-build-cache-'));
    const plan = makeBuildPlan({
      profile: studio,
      data,
      locked: studioLock,
      cell: linuxCell(studio, studioLock),
      variant: 'nonfree',
      imageId: 'abc123',
      cacheDir: cache,
    });
    expect(plan.name).toBe('ffmpeg-9.1.0-linux-x64-nonfree');
    expect(plan.platform).toBe('linux-x64');
    expect(plan.libraries.map((l) => `${l.name} ${l.version}`)).toEqual([
      'dav1d 1.5.4',
      'libdrm 2.4.134',
      'libva 2.24.1',
      'nv-codec 13.0.19.1',
      'opus 1.6.1',
      'mbedtls 3.6.5',
      'srt 1.5.8',
    ]);
    expect(plan.libraries.every((l) => !l.cached && /^[0-9a-f]{64}$/.test(l.key))).toBe(true);
    expect(plan.ffmpeg).toMatchObject({
      version: '9.1.0',
      archives: [
        'https://ffmpeg.org/releases/ffmpeg-9.1.0.tar.xz',
        'https://deb.debian.org/debian/pool/main/f/ffmpeg/ffmpeg_9.1.0.orig.tar.xz',
      ],
    });
    expect(plan.ffmpeg!.sha256).toBeUndefined(); // a lock without pins builds unpinned
    writeFileSync(join(cache, `${plan.libraries[0]!.key}.tar.gz`), '');
    const again = makeBuildPlan({
      profile: studio,
      data,
      locked: studioLock,
      cell: linuxCell(studio, studioLock),
      variant: 'nonfree',
      imageId: 'abc123',
      cacheDir: cache,
    });
    expect(again.libraries[0]!.cached).toBe(true);
  });
});

describe('the build plan of a pinned lock', () => {
  it('carries each pin to the source it pins: a git ref’s commit, a tarball’s sha256, FFmpeg’s sha256', () => {
    const COMMIT = 'c'.repeat(40);
    const SHA = 'f'.repeat(64);
    const locked: LockedProfile = {
      ...studioLock,
      pins: {
        ffmpeg: { '9': { sha256: SHA } },
        libraries: { dav1d: { commit: COMMIT }, mbedtls: { sha256: SHA } },
      },
    };
    const plan = makeBuildPlan({
      profile: studio,
      data,
      locked,
      cell: linuxCell(studio, locked),
      variant: 'nonfree',
      imageId: 'x',
      cacheDir: tmpdir(),
    });
    const source = (n: string) => plan.libraries.find((l) => l.name === n)!.source;
    expect(source('dav1d')).toEqual({
      git: 'https://code.videolan.org/videolan/dav1d.git',
      ref: '1.5.4',
      commit: COMMIT,
    });
    expect(source('mbedtls')).toMatchObject({ sha256: SHA });
    expect(source('opus')).not.toHaveProperty('commit'); // no pin: fetched by its ref alone
    expect(plan.ffmpeg!.sha256).toBe(SHA);
  });

  it("takes FFmpeg's pin from the target's own series, not from whichever series has the same version", () => {
    const [A, B] = ['a'.repeat(64), 'b'.repeat(64)];
    const locked: LockedProfile = {
      ...studioLock,
      ffmpeg: { ...studioLock.ffmpeg, '9.1': studioLock.ffmpeg['9']! },
      pins: { ffmpeg: { '9': { sha256: A }, '9.1': { sha256: B } }, libraries: {} },
    };
    const cell = linuxCell(studio, locked);
    const of = (series: string) =>
      makeBuildPlan({
        profile: studio,
        data,
        locked,
        cell: { ...cell, cell: { ...cell.cell, series } },
        variant: 'nonfree',
        imageId: 'x',
        cacheDir: tmpdir(),
      }).ffmpeg!.sha256;
    expect(of('9.1')).toBe(B);
    expect(of('9')).toBe(A);
  });
});

describe('docker mounts', () => {
  it('uses --mount so Windows paths with spaces and drive letters work', () => {
    const args = mountArgs({
      recipes: 'D:\\My Builds\\recipes',
      engine: 'D:\\e\\platforms',
      package: 'D:\\e',
      cache: 'C:\\c',
      out: 'D:\\out',
      plan: 'C:\\t\\plan.json',
    });
    expect(
      mountArgs({
        recipes: 'D:\\a,b',
        engine: 'e',
        package: 'f',
        cache: 'c',
        out: 'o',
        plan: 'p',
      })[1],
    ).toBe('type=bind,"source=D:\\a,b",target=/recipes,readonly');
    expect(args).toEqual([
      '--mount',
      'type=bind,source=D:\\My Builds\\recipes,target=/recipes,readonly',
      '--mount',
      'type=bind,source=D:\\e\\platforms,target=/engine,readonly',
      '--mount',
      'type=bind,source=D:\\e,target=/ffmpeg-build,readonly',
      '--mount',
      'type=bind,source=C:\\c,target=/cache',
      '--mount',
      'type=bind,source=D:\\out,target=/out',
      '--mount',
      'type=bind,source=C:\\t\\plan.json,target=/plan.json,readonly',
    ]);
  });
});

describe('review fixes', () => {
  it('chain the key of a uses member that is in the build', () => {
    const keysWith = (mbedtls: string, recipes: string[]) =>
      cacheKeys(data, recipes, (r) => ({ mbedtls, srt: '1.5.8' })[r]!, 'linux-x64', 'abc').get(
        'srt',
      );
    expect(keysWith('3.6.8', ['mbedtls', 'srt'])).not.toBe(keysWith('3.6.7', ['mbedtls', 'srt']));
    expect(keysWith('3.6.8', ['srt'])).toBe(keysWith('3.6.7', ['srt'])); // mbedtls not in this build
  });

  it('counts the image, platform data and Node toolchain modules as the toolchain', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-driver-'));
    mkdirSync(join(root, 'src', 'build'), { recursive: true });
    writeFileSync(join(root, 'platforms.yml'), 'platforms: {}\n');
    // a checkout (src/build/worker.ts is there): its TypeScript modules are the ones that run
    for (const file of ['worker.ts', 'toolchain.ts', 'library.ts', 'ffmpeg.ts', 'stage.ts']) {
      writeFileSync(join(root, 'src', 'build', file), `${file}\n`);
    }
    const id = () => toolchainIdentity(root, 'sha256:aaa', 'linux');
    const before = id();
    expect(toolchainIdentity(root, 'sha256:bbb', 'linux')).not.toBe(before);
    writeFileSync(join(root, 'src', 'build', 'stage.ts'), 'changed\n');
    const afterModule = id();
    expect(afterModule).not.toBe(before);
    writeFileSync(join(root, 'platforms.yml'), 'platforms: { linux-x64: {} }\n');
    expect(id()).not.toBe(afterModule);
  });

  it('refuses a toolchain definition that is not implemented', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-driver-'));
    expect(() => toolchainIdentity(root, 'id', 'missing')).toThrow(
      /unknown platform toolchain missing/,
    );
  });

  it('tags each toolchain image by its name and Dockerfile', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-images-'));
    mkdirSync(join(root, 'images', 'linux-musl-x64'), { recursive: true });
    writeFileSync(join(root, 'images', 'linux-musl-x64', 'Dockerfile'), 'FROM alpine\n');
    expect(imageTag(root, 'linux-musl-x64')).toMatch(/^ffmpeg-build-linux-musl-x64:[0-9a-f]{12}$/);
  });

  it("puts the platform's setup in the plan", () => {
    expect(
      makeBuildPlan({
        profile: studio,
        data,
        locked: studioLock,
        cell: linuxCell(studio, studioLock),
        variant: 'nonfree',
        imageId: 'x',
        cacheDir: tmpdir(),
      }).setup,
    ).toBe('linux');
  });

  it("hands the build's files back to the host user on Linux, and nowhere else", () => {
    const linux = dockerRunArgs({
      tag: 'img:1',
      recipes: 'r',
      engine: 'e',
      package: 'f',
      cache: 'c',
      out: 'o',
      plan: 'p',
      hostUser: { uid: 1001, gid: 118 },
    });
    expect(linux.join(' ')).toContain('-e FFB_HOST_UID=1001 -e FFB_HOST_GID=118');
    expect(hostUserOf('win32')).toBeUndefined();
    expect(hostUserOf('darwin')).toBeUndefined();
  });

  it('runs the driver with --init, so Ctrl-C stops the container', () => {
    // this checkout: the TypeScript worker (an installed package runs dist/'s; tests/modules.test.ts)
    const args = dockerRunArgs({
      tag: 'img:1',
      recipes: 'r',
      engine: 'e',
      package: packageRoot,
      cache: 'c',
      out: 'o',
      plan: 'p',
    });
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '--init']);
    expect(args.slice(-3)).toEqual(['img:1', 'node', '/ffmpeg-build/src/build/worker.ts']);
  });

  it('records the container id, so a stopped build can stop its container', () => {
    const args = dockerRunArgs({
      tag: 'img:1',
      recipes: 'r',
      engine: 'e',
      package: packageRoot,
      cache: 'c',
      out: 'o',
      plan: 'p',
      cidfile: '/tmp/x/cid',
    });
    expect(args.join(' ')).toContain('--cidfile /tmp/x/cid');
  });

  it('stops the container on a signal, and removes one its client left when the build did not finish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-cid-'));
    const cidfile = join(dir, 'cid');
    writeFileSync(cidfile, 'abc123\n');
    const calls: string[] = [];
    const cleanup = containerCleanup(cidfile, 'docker', async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
    });
    await cleanup.onInterrupt!('SIGTERM');
    await cleanup.afterExit!({ code: 143, signal: 'SIGTERM' });
    await cleanup.afterExit!({ code: 0 }); // a finished build's container is gone already (--rm)
    expect(calls).toEqual(['docker stop --time 10 abc123', 'docker rm --force abc123']);
  });

  it('remembers the last ERROR line, to name what failed', async () => {
    const script =
      "console.log('compiling'); console.error('ERROR: building x265 4.3 failed (see above)'); process.exit(3)";
    expect(await runStreaming(process.execPath, ['-e', script])).toEqual({
      code: 3,
      lastError: 'building x265 4.3 failed (see above)',
    });
  });
});

describe('recipe extras for 3b', () => {
  const engine = () =>
    loadEngineData(
      writeEngine({
        'ffmpeg/9.yml': [
          'major: 9',
          'releases: [9.0.0]',
          'options:',
          '  opencore-amrnb: { needs: opencore-amr, configure: [--enable-libopencore-amrnb] }',
          '  opencore-amrwb: { needs: opencore-amr, configure: [--enable-libopencore-amrwb] }',
          '  vulkan: { needs: vulkan-loader }',
          '',
        ].join('\n'),
        'recipes/opencore-amr/recipe.yml':
          'name: opencore-amr\nlicense: Apache-2.0\nconfigure: [--enable-libopencore-amrnb, --enable-libopencore-amrwb]\nsource: { url: "https://example.com/opencore-amr-{version}.tar.gz" }\nversions: { listing: "https://example.com/", files: \'^opencore-amr-(\\d+\\.\\d+\\.\\d+)\\.tar\\.gz$\' }\nplatforms: all\n',
        'recipes/vulkan-loader/recipe.yml':
          "name: vulkan-loader\nlicense: Apache-2.0\nconfigure: [--enable-vulkan]\nsource: { git: https://example.com/loader, ref: 'vulkan-sdk-{version}' }\nversions: { git-tags: '^vulkan-sdk-(\\d+\\.\\d+\\.\\d+\\.\\d+)$' }\nruntime: ['lib/libvulkan.so*']\nplatforms: [linux-*]\n",
      }),
    );

  it('lets an option give its own configure flags instead of its recipe', () => {
    const data2 = engine();
    const p = profile(
      'name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv3\nwith: [opencore-amrnb]\n',
    );
    const cell = planProfile(p, data2, { '9': '9.0.0' }).cells[0]!;
    expect(configureFlags(data2, cell)).toContain('--enable-libopencore-amrnb');
    expect(configureFlags(data2, cell)).not.toContain('--enable-libopencore-amrwb');
  });

  it("collects the files recipes ship next to FFmpeg's libraries", () => {
    const data2 = engine();
    const p = profile(
      'name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv3\nwith: [vulkan]\n',
    );
    const cell = planProfile(p, data2, { '9': '9.0.0' }).cells[0]!;
    const locked = {
      ffmpeg: { '9': '9.0.0' },
      libraries: { 'vulkan-loader': '1.4.363.0' },
      pinned: [],
    };
    const plan = makeBuildPlan({
      profile: p,
      data: data2,
      locked,
      cell,
      variant: 'lgplv3',
      imageId: 'x',
      cacheDir: mkdtempSync(join(tmpdir(), 'c-')),
    });
    expect(plan.runtime).toEqual(['lib/libvulkan.so*']);
    expect(plan.libraries[0]!.source).toEqual({
      git: 'https://example.com/loader',
      ref: 'vulkan-sdk-1.4.363.0',
    });
  });

  // MoltenVK links into the libav* frameworks: Mac Catalyst also needs IOKit, iOS doesn't; and the Khronos loader
  // ships libvulkan.so* on Linux but libvulkan*.dylib on macOS
  const applePlatforms = [
    'platforms:',
    '  linux-x64: { image: linux-x64, setup: linux }',
    '  osx-arm64: { image: macos, setup: apple-macos }',
    '  ios-arm64: { image: macos, setup: apple-ios }',
    '  maccatalyst-arm64: { image: macos, setup: apple-ios }',
    '',
  ].join('\n');
  const perPlatform = () =>
    loadEngineData(
      writeEngine({
        'platforms.yml': applePlatforms,
        'ffmpeg/9.yml': [
          'major: 9',
          'releases: [9.0.0]',
          'options:',
          '  vulkan:',
          '    { needs: [{ vulkan-loader: { platforms: [linux-x64, osx-arm64] } }, { moltenvk: { platforms: [ios-arm64, maccatalyst-*] } }] }',
          '',
        ].join('\n'),
        'recipes/moltenvk/recipe.yml': [
          'name: moltenvk',
          'license: Apache-2.0',
          "configure: [--enable-vulkan, --enable-vulkan-static, { '--extra-libs=-framework IOKit': { platforms: [maccatalyst-*] } }]",
          "source: { git: https://example.com/moltenvk, ref: 'v{version}' }",
          "versions: { git-tags: '^v(\\d+\\.\\d+\\.\\d+)$' }",
          'platforms: [ios-arm64, maccatalyst-*]',
          '',
        ].join('\n'),
        'recipes/vulkan-loader/recipe.yml': [
          'name: vulkan-loader',
          'license: Apache-2.0',
          'configure: [--enable-vulkan]',
          "source: { git: https://example.com/loader, ref: 'vulkan-sdk-{version}' }",
          "versions: { git-tags: '^vulkan-sdk-(\\d+\\.\\d+\\.\\d+\\.\\d+)$' }",
          "runtime: [{ 'lib/libvulkan.so*': { platforms: [linux-*] } }, { 'lib/libvulkan*.dylib': { platforms: [osx-*] } }]",
          'platforms: [linux-x64, osx-arm64]',
          '',
        ].join('\n'),
      }),
    );
  const vulkanCell = (d: ReturnType<typeof perPlatform>, platform: string) => {
    const p = profile(
      `name: t\nffmpeg: 9\nplatforms: [${platform}]\nlicense: lgplv3\nwith: [vulkan]\n`,
    );
    return { p, cell: planProfile(p, d, { '9': '9.0.0' }).cells[0]! };
  };

  it('passes a recipe flag only on the platforms its entry names', () => {
    const d = perPlatform();
    const ios = configureFlags(d, vulkanCell(d, 'ios-arm64').cell);
    expect(ios).toEqual(expect.arrayContaining(['--enable-vulkan', '--enable-vulkan-static']));
    expect(ios).not.toContain('--extra-libs=-framework IOKit');
    expect(configureFlags(d, vulkanCell(d, 'maccatalyst-arm64').cell)).toEqual(
      expect.arrayContaining(['--enable-vulkan-static', '--extra-libs=-framework IOKit']),
    );
    expect(verifyNames(d, vulkanCell(d, 'maccatalyst-arm64').cell)).toEqual(
      expect.arrayContaining(['VULKAN', 'VULKAN_STATIC']),
    );
  });

  it('ships a runtime file only on the platforms its entry names', () => {
    const d = perPlatform();
    const runtimeOn = (platform: string) => {
      const { p, cell } = vulkanCell(d, platform);
      return makeBuildPlan({
        profile: p,
        data: d,
        locked: {
          ffmpeg: { '9': '9.0.0' },
          libraries: { 'vulkan-loader': '1.4.363.0' },
          pinned: [],
        },
        cell,
        variant: 'lgplv3',
        imageId: 'x',
        cacheDir: mkdtempSync(join(tmpdir(), 'c-')),
      }).runtime;
    };
    expect(runtimeOn('linux-x64')).toEqual(['lib/libvulkan.so*']);
    expect(runtimeOn('osx-arm64')).toEqual(['lib/libvulkan*.dylib']);
  });

  it('fills dash and underscore version templates', () => {
    expect(expandTemplate('R_{version_}', '2.8.3')).toBe('R_2_8_3');
    expect(expandTemplate('VER-{version-}', '2.14.3')).toBe('VER-2-14-3');
  });
});

describe('cache keys per platform', () => {
  const platformEngine = (cPlatforms = 'all', cLicense = 'MIT') => {
    const recipe = (name: string, extra = '') =>
      `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n${extra}`;
    return loadEngineData(
      writeEngine({
        'ffmpeg/9.yml': 'major: 9\nreleases: [9.0.0]\noptions:\n  a: { needs: a }\n',
        'recipes/a/recipe.yml': recipe('a', 'needs: [b, { c: { platforms: [win-*] } }]\n'),
        'recipes/b/recipe.yml': recipe('b'),
        'recipes/c/recipe.yml': recipe('c')
          .replace('license: MIT', `license: ${cLicense}`)
          .replace('platforms: all', `platforms: ${cPlatforms}`),
      }),
    );
  };

  it('chain a platform-limited dependency only where it applies', () => {
    const d = platformEngine();
    const keyOfA = (c: string, platform: string) =>
      cacheKeys(d, ['b', 'c', 'a'], (r) => ({ a: '1', b: '1', c })[r]!, platform, 'tc').get('a');
    expect(keyOfA('1', 'win-x64')).not.toBe(keyOfA('2', 'win-x64'));
    expect(keyOfA('1', 'linux-x64')).toBe(keyOfA('2', 'linux-x64'));
  });
});

describe('native builds', () => {
  it("point FFmpeg at the build's own deps folder", () => {
    const flags = configureFlags(
      data,
      linuxCell(studio, studioLock),
      '/Users/me/ffmpeg-build-work/deps/osx-arm64',
    );
    expect(flags).toContain('--extra-cflags=-I/Users/me/ffmpeg-build-work/deps/osx-arm64/include');
    expect(flags).toContain('--extra-ldflags=-L/Users/me/ffmpeg-build-work/deps/osx-arm64/lib');
    expect(configureFlags(data, linuxCell(studio, studioLock))).toContain(
      '--extra-cflags=-I/opt/ffmpeg-build/deps/include',
    );
  });

  it('carry the deps folder in the plan', () => {
    const plan = makeBuildPlan({
      profile: studio,
      data,
      locked: studioLock,
      cell: linuxCell(studio, studioLock),
      variant: 'nonfree',
      imageId: 'x',
      cacheDir: tmpdir(),
      depsDir: '/Users/me/d',
    });
    expect(plan.ffmpeg!.configure).toContain('--extra-cflags=-I/Users/me/d/include');
  });
});
