import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeBuildPlan } from '../src/build/plan.ts';
import { createToolchain } from '../src/build/toolchain.ts';
import { checkProfile } from '../src/check.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { readFolderLock } from '../src/lockfile.ts';
import { packageRoot } from '../src/paths.ts';
import { targetFacts } from '../src/release.ts';
import { planProfile } from '../src/resolve.ts';
import { loadFolder, parseFolderText, type Target, targetProfile } from '../src/targets.ts';

const data = loadEngineData(packageRoot);
const builds = (() => {
  const r = loadFolder(join(packageRoot, 'examples', 'test-builds'));
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return r.folder;
})();
const lock = readFolderLock(join(builds.dir, 'ffmpeg.lock'))!;
// the test-builds android target without its own android-api:, which each test sets as it needs
const android: Target = { ...builds.targets.find((t) => t.platform === 'android-arm64')! };
delete android.androidApi;

/** The test-builds android target, changed: its android-api:, more options, another platform. */
function variant(change: Partial<Target>) {
  const t: Target = { ...android, ...change };
  const profile = targetProfile(builds, t);
  return {
    profile,
    cell: planProfile(profile, data, { [t.ffmpeg]: lock.ffmpeg[t.ffmpeg]! }).cells[0]!,
  };
}
const problems = (change: Partial<Target>): string[] => {
  const { profile } = variant(change);
  return checkProfile({ ok: true, profile }, data, { versions: lock.ffmpeg })
    .blocks.flatMap((b) => b.lines)
    .filter((l) => l.mark === '✗')
    .map((l) => l.text);
};
function plan(change: Partial<Target>) {
  const { profile, cell } = variant(change);
  return makeBuildPlan({
    profile,
    data,
    locked: { ffmpeg: lock.ffmpeg, libraries: lock.libraries, pinned: [] },
    cell,
    variant: android.name,
    imageId: 'img',
    cacheDir: mkdtempSync(join(tmpdir(), 'ffmpeg-build-cache-')),
  });
}

describe('android-api: the Android API level an android build is made for', () => {
  it('is a level from 21 to 35 on a target, read as a number', () => {
    const parse = (api: string) =>
      parseFolderText(
        `targets:\n  a: { platform: android-arm64, license: lgplv3, ffmpeg: 9, with: [dav1d], android-api: ${api} }\n`,
        '.',
      );
    const ok = parse('24');
    expect(ok.ok && ok.folder.targets[0]!.androidApi).toBe(24);
    for (const bad of ['20', '36', 'lollipop']) {
      const r = parse(bad);
      expect(!r.ok && r.errors.join('\n')).toContain(
        'expected an Android API level from 21 to 35, like 24',
      );
    }
  });

  it('defaults to 28, and goes into the plan and the library cache keys', () => {
    const before = plan({});
    expect(before.androidApi).toBe(28);
    const lower = plan({ androidApi: 24 });
    expect(lower.androidApi).toBe(24);
    // a library built for 28 may call what 24 lacks: each level has its own cache entries
    expect(lower.libraries.map((l) => l.key)).not.toEqual(before.libraries.map((l) => l.key));
    expect(plan({ androidApi: 28 }).libraries.map((l) => l.key)).toEqual(
      before.libraries.map((l) => l.key),
    );
    // a target that sets it has a new definition (its release is due)
    const definition = (change: Partial<Target>) => {
      const r = targetFacts(builds, { ...android, ...change }, data, lock, packageRoot);
      return 'facts' in r ? r.facts.definition : r.error;
    };
    expect(definition({ androidApi: 24 })).not.toBe(definition({}));
  });

  it('compiles for the level: the NDK driver, its API and CMake platform', () => {
    const toolchain = (api?: number) =>
      createToolchain({
        platform: 'android-arm64',
        setup: 'android',
        depsDir: join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-tc-')), 'deps'),
        work: '/work',
        engine: '/engine',
        env: { ANDROID_NDK_HOME: '/ndk' },
        ...(api !== undefined ? { androidApi: api } : {}),
      });
    const at24 = toolchain(24);
    expect(at24.env).toMatchObject({
      API: '24',
      CC: '/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang',
      CXX: '/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android24-clang++',
    });
    expect(at24.cmakeArgs).toContain('-DANDROID_PLATFORM=android-24');
    // a plan made before android-api: has none: 28, as always
    expect(toolchain().env['API']).toBe('28');
    expect(toolchain().cmakeArgs).toContain('-DANDROID_PLATFORM=android-28');
  });

  it("check refuses a level older than an option or library supports, naming it; and one on a target that isn't android", () => {
    expect(problems({ androidApi: 24 })).toEqual([]);
    expect(problems({ androidApi: 24, with: [...android.with, 'iconv'] })).toContain(
      'android-api: 24 is older than option iconv supports (API 28+): raise android-api: to 28, or build without it',
    );
    expect(problems({ androidApi: 24, with: [...android.with, 'whisper'] })).toContain(
      'android-api: 24 is older than library whisper.cpp supports (API 28+): raise android-api: to 28, or build without it',
    );
    expect(problems({ androidApi: 24, with: [...android.with, 'vulkan'] })).toContain(
      'android-api: 24 is older than option vulkan supports (API 28+): raise android-api: to 28, or build without it',
    );
    expect(problems({ androidApi: 28, with: [...android.with, 'whisper', 'iconv'] })).toEqual([]);
    expect(problems({ androidApi: 24, platform: 'linux-x64' })).toContain(
      'android-api: 24: only an android-* target is made for an Android API level',
    );
    // the plan refuses it too, should anything build without check
    expect(() => plan({ androidApi: 24, with: [...android.with, 'iconv'] })).toThrow(
      'option iconv supports (API 28+)',
    );
  });
});
