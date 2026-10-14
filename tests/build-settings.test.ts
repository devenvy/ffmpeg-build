// ffmpeg-build.yml's build: section: where (runner) and how (in: docker | here) each platform's targets build.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureData, fixtureEngineRoot, runCli } from './helpers.ts';
import { buildSettingProblems, buildSettings } from '../src/build-settings.ts';
import { formatFolderLock } from '../src/lockfile.ts';
import { packageRoot } from '../src/paths.ts';
import { planReleases } from '../src/release.ts';
import { parseFolderText } from '../src/targets.ts';

const TARGETS =
  'targets:\n  lin: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d] }\n';
const parse = (text: string) => parseFolderText(text, '/f');
const folderOf = (text: string) => {
  const r = parse(text);
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return r.folder;
};
const LOCK = { engine: '0.2.0', ffmpeg: { '9': '9.1.0' }, libraries: { dav1d: '1.5.4' } };

describe('the build: section', () => {
  it('is optional, keyed by platform pattern; later entries override earlier ones, key by key', () => {
    expect(buildSettings(folderOf(TARGETS), 'linux-x64')).toEqual({});
    const f = folderOf(
      `build:\n  'linux-*': { runner: [self-hosted, Linux, X64], in: here }\n  linux-x64: { in: docker }\n${TARGETS}`,
    );
    expect(buildSettings(f, 'linux-x64')).toEqual({
      runner: ['self-hosted', 'Linux', 'X64'],
      in: 'docker',
    });
    expect(buildSettings(f, 'linux-arm64')).toEqual({
      runner: ['self-hosted', 'Linux', 'X64'],
      in: 'here',
    });
  });

  it('refuses a pattern that is no platform, and an unknown way to build', () => {
    const pattern = parse(`build:\n  linux-x46: { in: here }\n${TARGETS}`);
    expect(pattern.ok ? [] : pattern.errors).toContain(
      'build: linux-x46 names no platform ffmpeg-build knows',
    );
    const how = parse(`build:\n  win-*: { in: vm }\n${TARGETS}`);
    expect(how.ok ? [] : how.errors).toContain('build.win-*.in: expected one of docker, here');
  });

  it('gives releases the runner it names, tested there too', () => {
    const data = fixtureData();
    const one = planReleases(
      folderOf(`build:\n  linux-x64: { runner: ubuntu-22.04 }\n${TARGETS}`),
      data,
      LOCK,
      packageRoot,
    ).releases[0]!.targets[0]!;
    expect([one.runner, one.testRunner]).toEqual(['ubuntu-22.04', 'ubuntu-22.04']);
    const labels = planReleases(
      folderOf(`build:\n  linux-x64: { runner: [self-hosted, Linux, X64], in: here }\n${TARGETS}`),
      data,
      LOCK,
      packageRoot,
    ).releases[0]!.targets[0]!;
    expect([labels.runner, labels.testRunner]).toEqual([
      ['self-hosted', 'Linux', 'X64'],
      ['self-hosted', 'Linux', 'X64'],
    ]);
  });

  it("keeps the platform's own test runner for a Docker build moved to another Linux runner", () => {
    const data = fixtureData();
    data.platforms.set('win-x64', {
      ...data.platforms.get('linux-x64')!,
      runner: 'ubuntu-24.04',
      testRunner: 'windows-2025',
    });
    const win =
      'targets:\n  win: { platform: win-x64, license: lgplv3, ffmpeg: 9, with: [dav1d] }\n';
    const moved = planReleases(
      folderOf(`build:\n  win-x64: { runner: ubuntu-22.04 }\n${win}`),
      data,
      LOCK,
      packageRoot,
    );
    expect(moved.errors).toEqual([]);
    const docker = moved.releases[0]!.targets[0]!;
    expect([docker.runner, docker.testRunner]).toEqual(['ubuntu-22.04', 'windows-2025']);
    const native = planReleases(
      folderOf(`build:\n  win-x64: { runner: windows-2025, in: here }\n${win}`),
      data,
      LOCK,
      packageRoot,
    ).releases[0]!.targets[0]!;
    expect([native.runner, native.testRunner]).toEqual(['windows-2025', 'windows-2025']);
  });

  it('makes how a target builds part of its toolchain: a change makes the release due; a Docker build moved to another runner is the same build', () => {
    const data = fixtureData();
    const toolchain = (build: string) =>
      planReleases(folderOf(`${build}${TARGETS}`), data, LOCK, packageRoot).releases[0]!.targets[0]!
        .facts.toolchain;
    const plain = toolchain('');
    expect(toolchain('build:\n  linux-x64: { in: docker }\n')).toBe(plain);
    expect(toolchain('build:\n  linux-x64: { runner: ubuntu-22.04 }\n')).toBe(plain);
    expect(toolchain('build:\n  linux-x64: { in: here }\n')).not.toBe(plain);
    expect(
      toolchain('build:\n  linux-x64: { in: here, runner: [self-hosted, Linux, X64] }\n'),
    ).not.toBe(toolchain('build:\n  linux-x64: { in: here }\n'));
  });
});

describe('releases --json', () => {
  it('says where each target builds and runs, whether that is the same runner, and how it builds', () => {
    const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-settings-rel-'));
    writeFileSync(
      join(d, 'ffmpeg-build.yml'),
      `build:\n  linux-x64: { runner: [self-hosted, Linux, X64], in: here }\n${TARGETS}`,
    );
    writeFileSync(join(d, 'ffmpeg.lock'), formatFolderLock(LOCK));
    const r = runCli(['releases', '--json', '--offline'], {
      cwd: d,
      env: { FFMPEG_BUILD_DATA: fixtureEngineRoot },
    });
    expect(r.exitCode).toBe(0);
    const [t] = (
      JSON.parse(r.stdout) as {
        targets: { runner: unknown; testRunner: unknown; testHere: boolean; in: string }[];
      }[]
    )[0]!.targets;
    expect(t).toMatchObject({
      runner: ['self-hosted', 'Linux', 'X64'],
      testRunner: ['self-hosted', 'Linux', 'X64'],
      testHere: true,
      in: 'here',
    });
  });
});

describe('impossible ways to build', () => {
  const problems = (platform: string, settings: Parameters<typeof buildSettingProblems>[1]) =>
    buildSettingProblems(platform, settings);

  it('Apple builds natively on a Mac', () => {
    expect(problems('osx-arm64', {}).errors).toEqual([]);
    expect(problems('ios-arm64', { in: 'docker' }).errors).toEqual([
      'ios-arm64: Apple builds run natively on a Mac; drop in: docker',
    ]);
    expect(problems('osx-arm64', { runner: 'ubuntu-24.04' }).errors).toEqual([
      'osx-arm64: Apple builds need a macOS runner, not ubuntu-24.04',
    ]);
  });

  it('Docker needs a Linux runner', () => {
    expect(problems('win-x64', { runner: 'windows-2025' }).errors).toEqual([
      "win-x64: a Docker build needs a Linux runner (windows-2025 can't run the Linux images); use in: here for a native build there",
    ]);
    expect(problems('linux-x64', { runner: 'macos-15' }).errors).toEqual([
      "linux-x64: a Docker build needs a Linux runner (macos-15 can't run the Linux images)",
    ]);
  });

  it('in: here builds for the machine it runs on', () => {
    expect(problems('win-x64', { runner: 'windows-2025', in: 'here' }).errors).toEqual([]);
    expect(problems('linux-arm64', { runner: 'ubuntu-24.04-arm', in: 'here' }).errors).toEqual([]);
    expect(problems('linux-arm64', { in: 'here' }).errors).toEqual([
      'linux-arm64: in: here builds for the runner it runs on, and ubuntu-24.04 is linux-x64',
    ]);
    expect(problems('win-x64', { in: 'here' }).errors).toEqual([
      'win-x64: in: here builds for the runner it runs on, and ubuntu-24.04 is linux-x64',
    ]);
    expect(problems('android-arm64', { in: 'here' }).errors).toEqual([
      'android-arm64: builds only in Docker (in: here is for linux-x64, linux-arm64, win-* and Apple)',
    ]);
  });

  it("trusts a runner it doesn't know, and says so", () => {
    const r = problems('win-x64', { runner: ['self-hosted', 'gpu-box'], in: 'here' });
    expect(r.errors).toEqual([]);
    expect(r.notes).toEqual([
      'win-x64: runner self-hosted, gpu-box is trusted to build win-x64 natively (ffmpeg-build can only check GitHub-hosted labels)',
    ]);
    expect(problems('osx-arm64', { runner: ['self-hosted', 'macOS', 'ARM64'] }).errors).toEqual([]);
    expect(problems('osx-arm64', { runner: ['self-hosted', 'Linux'] }).errors).toEqual([
      'osx-arm64: Apple builds need a macOS runner, not self-hosted, Linux',
    ]);
  });

  it('check reports them, before anything builds', () => {
    const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-settings-'));
    writeFileSync(
      join(d, 'ffmpeg-build.yml'),
      `build:\n  linux-x64: { runner: macos-15 }\n${TARGETS}`,
    );
    writeFileSync(join(d, 'ffmpeg.lock'), formatFolderLock(LOCK));
    const r = runCli(['check'], { cwd: d, env: { FFMPEG_BUILD_DATA: fixtureEngineRoot } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      "✗ linux-x64: a Docker build needs a Linux runner (macos-15 can't run the Linux images)",
    );
  });
});
