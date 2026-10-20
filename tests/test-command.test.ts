import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tarGz } from './github-fake.ts';
import { fixtureData, fixtureEngineRoot, runCli } from './helpers.ts';
import {
  androidSmoke,
  appleSmoke,
  libraryRun,
  pickSimulator,
  smokeResult,
} from '../src/commands/test-library.ts';
import {
  archiveEnv,
  baseImage,
  containerFor,
  dockerArgs,
  gitBash,
  isMusl,
  missingLicenseFlags,
  muslImage,
  runnablePlatforms,
  runTest,
  scriptCommand,
  versionMatches,
} from '../src/commands/test.ts';
import { formatFolderLock } from '../src/lockfile.ts';
import { loadFolder } from '../src/targets.ts';

const data = fixtureData();
const LOCK = { engine: '0.2.0', ffmpeg: { '9': '9.1.0' }, libraries: { dav1d: '1.5.4' } };

/** A folder with one linux-x64 target "built" into dist, its ffmpeg a script that answers like the real one. */
function built(
  tests: Record<string, string> = {},
  license = 'lgplv3',
  answers: string[] = [],
): string {
  const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-test-cmd-'));
  const list = Object.keys(tests);
  writeFileSync(
    join(d, 'ffmpeg-build.yml'),
    `targets:\n  t: { platform: linux-x64, license: ${license}, ffmpeg: 9, with: [dav1d]${list.length ? `, tests: [${list.join(', ')}]` : ''} }\n`,
  );
  writeFileSync(join(d, 'ffmpeg.lock'), formatFolderLock(LOCK));
  for (const [path, text] of Object.entries(tests)) {
    mkdirSync(join(d, path, '..'), { recursive: true });
    writeFileSync(join(d, path), text);
  }
  // `answers`: case arms ahead of the usual ones (another -buildconf, a listing)
  const ffmpeg = [
    '#!/usr/bin/env bash',
    'case "$*" in',
    ...answers.map((a) => `  ${a}`),
    '  *-version*) echo "ffmpeg version 9.1.0 Copyright" ;;',
    '  *-buildconf*) echo "  --disable-gpl --enable-version3 --disable-nonfree --enable-shared" ;;',
    '  *testsrc2*) exit 0 ;;',
    'esac',
  ].join('\n');
  mkdirSync(join(d, 'dist'));
  writeFileSync(
    join(d, 'dist', 'ffmpeg-9.1.0-t.tar.gz'),
    tarGz([{ name: 'ffmpeg', data: `${ffmpeg}\n`, mode: 0o755 }]),
  );
  return d;
}
const folderOf = (d: string) => {
  const r = loadFolder(d);
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return r.folder;
};

describe('ffmpeg-build test', () => {
  it('knows which builds this machine can run', () => {
    expect(runnablePlatforms('linux', 'x64', false, false)).toEqual(['linux-x64']);
    expect(runnablePlatforms('linux', 'x64', true, false)).toEqual(['linux-musl-x64']);
    // a Mac runs Mac Catalyst builds as its own processes, and iOS simulator builds in the simulator (Apple silicon)
    expect(runnablePlatforms('darwin', 'arm64', false, true)).toEqual([
      'osx-arm64',
      'maccatalyst-arm64',
      'ios-sim-arm64',
      'osx-x64',
      'maccatalyst-x64',
    ]);
    expect(runnablePlatforms('darwin', 'arm64', false, false)).toEqual([
      'osx-arm64',
      'maccatalyst-arm64',
      'ios-sim-arm64',
    ]);
    expect(runnablePlatforms('darwin', 'x64', false, false)).toEqual([
      'osx-x64',
      'maccatalyst-x64',
    ]);
    expect(runnablePlatforms('win32', 'x64', false, false)).toEqual(['win-x64']);
    expect(runnablePlatforms('win32', 'arm64', false, false)).toEqual(['win-arm64', 'win-x64']);
    expect(runnablePlatforms('linux', 'arm', false, false)).toEqual(['linux-armhf']);
    expect(runnablePlatforms('linux', 'arm', true, false)).toEqual([]); // no musl armhf build
  });

  it("tells musl from glibc by Node's report, not by a file Alpine happens to have", () => {
    // only Linux has musl; there, glibc's runtime version is missing from the report exactly when it is musl
    expect(isMusl()).toBe(
      process.platform === 'linux' &&
        !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header
          .glibcVersionRuntime,
    );
  });

  it('checks the exact version, and every licence flag the build passes to configure', () => {
    expect(versionMatches('ffmpeg version 9.1.0 Copyright (c) 2000-2026', '9.1.0')).toBe(true);
    expect(versionMatches('ffmpeg version 9.1.0', '9.1.0')).toBe(true);
    expect(versionMatches('ffmpeg version 9.1.01 Copyright', '9.1.0')).toBe(false);
    expect(versionMatches('ffmpeg version 9.1.0.1 Copyright', '9.1.0')).toBe(false);
    expect(versionMatches('ffmpeg version 9x1x0 Copyright', '9.1.0')).toBe(false);
    expect(missingLicenseFlags('--disable-gpl --enable-shared', 'lgplv3')).toEqual([
      '--enable-version3',
      '--disable-nonfree',
    ]);
    expect(
      missingLicenseFlags('--enable-gpl --enable-version3 --disable-nonfree', 'gplv2'),
    ).toEqual([]);
    expect(
      missingLicenseFlags('--enable-gpl --enable-version3 --disable-nonfree', 'nonfree'),
    ).toEqual(['--enable-nonfree']);
  });

  it('runs a musl x64 build in the pinned Alpine on a glibc x64 machine with Docker, and says so without Docker', async () => {
    expect(muslImage()).toMatch(/^mirror\.gcr\.io\/library\/alpine:[\d.]+@sha256:[0-9a-f]{64}$/);
    expect(
      dockerArgs(
        'alpine@sha256:x',
        ['/b', '/f'],
        '/f',
        { FFMPEG: '/b/bin/ffmpeg' },
        '/b/bin/ffmpeg',
        ['-version'],
      ),
    ).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      '/b:/b:ro',
      '-v',
      '/f:/f:ro',
      '-w',
      '/f',
      '-e',
      'FFMPEG=/b/bin/ffmpeg',
      'alpine@sha256:x',
      '/b/bin/ffmpeg',
      '-version',
    ]);
    const d = built();
    writeFileSync(
      join(d, 'ffmpeg-build.yml'),
      'targets:\n  t: { platform: linux-musl-x64, license: lgplv3, ffmpeg: 9, with: [dav1d] }\n',
    );
    expect(
      (
        await runTest(folderOf(d), data, {
          target: 't',
          dist: join(d, 'dist'),
          runnable: ['linux-x64'],
          docker: false,
        })
      ).output,
    ).toBe(
      "t: skipped, linux-musl-x64 builds don't run on this machine (it runs linux-x64) (with Docker it would run in an Alpine container)",
    );
  });

  it('runs musl and armhf builds in containers on a glibc Linux machine: Alpine for musl, Debian armhf for armhf', () => {
    expect(containerFor('linux-musl-x64', ['linux-x64'])).toEqual({
      image: 'linux-musl-x64',
      dockerPlatform: 'linux/amd64',
      bash: 'apk',
    });
    expect(containerFor('linux-musl-arm64', ['linux-arm64'])).toEqual({
      image: 'linux-musl-arm64',
      dockerPlatform: 'linux/arm64',
      bash: 'apk',
    });
    // 32-bit ARM userspace: under qemu on x64, and on arm64 too (GitHub's arm64 runners can't run AArch32 natively)
    expect(containerFor('linux-armhf', ['linux-x64'])).toEqual({
      image: 'cross-armhf',
      dockerPlatform: 'linux/arm/v7',
      bash: 'present',
    });
    expect(containerFor('linux-armhf', ['linux-arm64'])).toEqual({
      image: 'cross-armhf',
      dockerPlatform: 'linux/arm/v7',
      bash: 'present',
    });
    expect(containerFor('linux-musl-arm64', ['linux-x64'])).toBeUndefined();
    expect(containerFor('linux-musl-x64', ['linux-musl-x64'])).toBeUndefined();
    expect(containerFor('linux-x64', ['linux-x64'])).toBeUndefined();
    // the images the toolchains start from, pinned by the same (multi-platform) digest
    expect(baseImage('linux-musl-arm64')).toBe(muslImage());
    expect(baseImage('cross-armhf')).toMatch(
      /^mirror\.gcr\.io\/library\/debian:bookworm@sha256:[0-9a-f]{64}$/,
    );
    expect(dockerArgs('i', ['/b'], '/b', {}, 'sh', [], false, 'linux/arm/v7')).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      '--platform',
      'linux/arm/v7',
      '-v',
      '/b:/b:ro',
      '-w',
      '/b',
      'i',
      'sh',
    ]);
  });

  it("skips an armhf build when Docker can't start an armhf container, saying how to register qemu", async () => {
    const d = built();
    writeFileSync(
      join(d, 'ffmpeg-build.yml'),
      'targets:\n  t: { platform: linux-armhf, license: lgplv3, ffmpeg: 9, with: [dav1d] }\n',
    );
    const r = await runTest(folderOf(d), data, {
      target: 't',
      dist: join(d, 'dist'),
      runnable: ['linux-x64'],
      docker: true,
      armhf: false,
    });
    expect(r.output).toContain(
      "t: skipped, this machine's Docker can't start a linux/arm/v7 container",
    );
    expect(r.output).toContain(
      '--install arm (`ffmpeg-build doctor` says what this machine needs)',
    );
    expect(r.output).toContain('--install arm');
    expect(r.exitCode).toBe(0);
  });

  it('fails instead of skipping with --must-run (CI, on the runner meant to run the build)', async () => {
    const d = built();
    const r = await runTest(folderOf(d), data, {
      target: 't',
      dist: join(d, 'dist'),
      runnable: ['win-x64'],
      mustRun: true,
    });
    expect(r.output).toBe(
      "t: ✗ not run, linux-x64 builds don't run on this machine (it runs win-x64), and --must-run says it must",
    );
    expect(r.exitCode).toBe(1);
  });

  it('links the smoke program against an Android build with the NDK, and runs it on a device with that ABI', () => {
    expect(
      androidSmoke(
        'android-arm64',
        '/ndk',
        'linux-x86_64',
        '/run',
        '/out/smoke',
        '/src/smoke.c',
        28,
      ),
    ).toEqual({
      cmd: '/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android28-clang',
      args: [
        '/src/smoke.c',
        '-I',
        '/run/include',
        '-L',
        '/run/lib/arm64-v8a',
        '-lavformat',
        '-lavfilter',
        '-lavcodec',
        '-lswscale',
        '-lswresample',
        '-lavutil',
        '-Wl,-rpath,/data/local/tmp/ffmpeg-build-test',
        '-o',
        '/out/smoke',
      ],
    });
    // linked for the level the build was made for (android-api:)
    expect(androidSmoke('android-x64', '/ndk', 'linux-x86_64', '/run', '/o', '/s.c', 24).cmd).toBe(
      '/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android24-clang',
    );
  });

  it('links the smoke program against iOS and Mac Catalyst frameworks with the SDK of each', () => {
    expect(appleSmoke('ios-arm64', '/sdk', '/run', '/dev/include', '/o', '/s.c')).toEqual({
      cmd: 'xcrun',
      args: [
        '--sdk',
        'iphoneos',
        'clang',
        '-arch',
        'arm64',
        '-miphoneos-version-min=13.0',
        '-isysroot',
        '/sdk',
        '/s.c',
        '-I',
        '/dev/include',
        '-F',
        '/run',
        '-framework',
        'libavformat',
        '-framework',
        'libavfilter',
        '-framework',
        'libavcodec',
        '-framework',
        'libswscale',
        '-framework',
        'libswresample',
        '-framework',
        'libavutil',
        '-Wl,-rpath,/run',
        '-o',
        '/o',
      ],
    });
    expect(
      appleSmoke('ios-sim-arm64', '/sdk', '/run', undefined, '/o', '/s.c').args.slice(0, 6),
    ).toEqual([
      '--sdk',
      'iphonesimulator',
      'clang',
      '-arch',
      'arm64',
      '-mios-simulator-version-min=13.0',
    ]);
    expect(
      appleSmoke('maccatalyst-x64', '/sdk', '/run', undefined, '/o', '/s.c').args.slice(0, 11),
    ).toEqual([
      '--sdk',
      'macosx',
      'clang',
      '-target',
      'x86_64-apple-ios14.0-macabi',
      '-isysroot',
      '/sdk',
      '-iframework',
      '/sdk/System/iOSSupport/System/Library/Frameworks',
      '-L',
      '/sdk/System/iOSSupport/usr/lib',
    ]);
  });

  it('says where each library build can run: here, under Rosetta, in the simulator, on a device, or nowhere', () => {
    expect(libraryRun('maccatalyst-arm64', 'darwin', 'arm64', false)).toEqual({ where: 'here' });
    expect(libraryRun('maccatalyst-x64', 'darwin', 'arm64', true)).toEqual({ where: 'rosetta' });
    expect(libraryRun('maccatalyst-x64', 'darwin', 'arm64', false)).toEqual({
      where: 'nowhere',
      why: "an x86_64 Mac Catalyst build runs on Apple silicon only under Rosetta, which isn't installed (softwareupdate --install-rosetta --agree-to-license)",
    });
    expect(libraryRun('ios-sim-arm64', 'darwin', 'arm64', false)).toEqual({ where: 'simulator' });
    expect(libraryRun('ios-sim-arm64', 'darwin', 'x64', false)).toMatchObject({ where: 'nowhere' });
    expect(libraryRun('ios-arm64', 'darwin', 'arm64', false)).toEqual({
      where: 'never',
      why: 'iOS device builds run only on an iOS device',
    });
    expect(libraryRun('android-arm64', 'linux', 'x64', false)).toEqual({ where: 'device' });
  });

  it('picks the newest available iOS runtime and an iPhone it supports', () => {
    const runtimes = {
      runtimes: [
        {
          name: 'iOS 17.5',
          identifier: 'rt.17',
          isAvailable: true,
          supportedDeviceTypes: [{ name: 'iPhone 15', identifier: 'dt.15' }],
        },
        {
          name: 'watchOS 11',
          identifier: 'rt.w',
          isAvailable: true,
          supportedDeviceTypes: [{ name: 'Apple Watch', identifier: 'dt.w' }],
        },
        {
          name: 'iOS 18.2',
          identifier: 'rt.18',
          isAvailable: true,
          supportedDeviceTypes: [
            { name: 'iPad Pro', identifier: 'dt.ipad' },
            { name: 'iPhone 16', identifier: 'dt.16' },
          ],
        },
        {
          name: 'iOS 19.0',
          identifier: 'rt.19',
          isAvailable: false,
          supportedDeviceTypes: [{ name: 'iPhone 17', identifier: 'dt.17' }],
        },
      ],
    };
    expect(pickSimulator(runtimes)).toEqual({ runtime: 'rt.18', deviceType: 'dt.16' });
    expect(pickSimulator({ runtimes: [] })).toBeUndefined();
  });

  it("reads the smoke program's output as the program checks read ffmpeg's: version, licence flags, ok", () => {
    const out =
      'ffmpeg version 9.1.0\nconfiguration: --disable-gpl --enable-version3 --disable-nonfree\nsmoke: ok\n';
    expect(smokeResult(0, out, '9.1.0', 'lgplv3')).toEqual([
      { ok: true, what: 'it says FFmpeg 9.1.0' },
      { ok: true, what: 'its configure line matches lgplv3' },
      { ok: true, what: 'it encodes, decodes and finds the built-in components' },
    ]);
    expect(
      smokeResult(
        1,
        'ffmpeg version 9.1.0\nconfiguration: --enable-gpl\nsmoke: FAIL no mpeg4 encoder or decoder\n',
        '9.1.0',
        'lgplv3',
      ).map((s) => s.ok),
    ).toEqual([true, false, false]);
  });

  it('skips an Android build without the NDK, and fails it with --must-run', async () => {
    const d = built();
    writeFileSync(
      join(d, 'ffmpeg-build.yml'),
      'targets:\n  t: { platform: android-arm64, license: lgplv3, ffmpeg: 9, with: [dav1d] }\n',
    );
    writeFileSync(
      join(d, 'dist', 'ffmpeg-9.1.0-t.tar.gz'),
      tarGz([{ name: 'lib/arm64-v8a/libavutil.so', data: 'x', mode: 0o644 }]),
    );
    const env = {
      ANDROID_NDK_HOME: '',
      ANDROID_NDK_LATEST_HOME: '',
      ANDROID_NDK_ROOT: '',
      ANDROID_NDK: '',
    };
    const skipped = await runTest(folderOf(d), data, {
      target: 't',
      dist: join(d, 'dist'),
      runnable: ['linux-x64'],
      env,
    });
    expect(skipped.output).toBe(
      't: skipped, linking a program against an android-arm64 build needs the Android NDK (set ANDROID_NDK_HOME) (`ffmpeg-build doctor` says what this machine needs)',
    );
    expect(skipped.exitCode).toBe(0);
    expect(
      (
        await runTest(folderOf(d), data, {
          target: 't',
          dist: join(d, 'dist'),
          runnable: ['linux-x64'],
          env,
          mustRun: true,
        })
      ).exitCode,
    ).toBe(1);
  });

  it('runs test scripts on Windows with Git Bash (never WSL), cmd and PowerShell', () => {
    const none = () => undefined;
    expect(scriptCommand('C:\\f\\t.sh', 'win32', { bash: none })).toEqual({
      error:
        "needs Git Bash, which isn't found: install Git for Windows, or set BASH to its bash.exe (WSL's bash isn't used; `ffmpeg-build doctor` says what this machine needs)",
    });
    expect(scriptCommand('C:\\f\\t.sh', 'win32', { bash: () => 'G:\\Git\\bin\\bash.exe' })).toEqual(
      { cmd: 'G:\\Git\\bin\\bash.exe', args: ['C:\\f\\t.sh'] },
    );
    expect(scriptCommand('C:\\f\\t.cmd', 'win32')).toMatchObject({
      args: ['/d', '/s', '/c', '""C:\\f\\t.cmd""'],
      verbatim: true,
    });
    expect(scriptCommand('C:\\f\\t.ps1', 'win32', { pwsh: () => 'pwsh' })).toEqual({
      cmd: 'pwsh',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\f\\t.ps1'],
    });
    expect(scriptCommand('C:\\f\\t.ps1', 'win32', { pwsh: none })).toEqual({
      error: 'needs PowerShell: neither pwsh nor powershell is on PATH',
    });
    expect(scriptCommand('/f/t.sh', 'linux')).toEqual({ cmd: 'bash', args: ['/f/t.sh'] });
  });

  it.runIf(process.platform === 'win32')(
    'finds Git Bash: $BASH, beside git (<git>/mingw64/libexec/git-core), then the install folders; never system32',
    () => {
      const files = new Set([
        'C:\\Git\\bin\\bash.exe',
        'C:\\windows\\system32\\bash.exe',
        'P:\\Git\\bin\\bash.exe',
      ]);
      const exists = (p: string) => files.has(p);
      expect(
        gitBash(
          { BASH: 'C:\\windows\\system32\\bash.exe' },
          exists,
          () => 'C:\\Git\\mingw64\\libexec\\git-core',
        ),
      ).toBe('C:\\Git\\bin\\bash.exe');
      expect(
        gitBash(
          { BASH: 'P:\\Git\\bin\\bash.exe' },
          exists,
          () => 'C:\\Git\\mingw64\\libexec\\git-core',
        ),
      ).toBe('P:\\Git\\bin\\bash.exe');
      expect(gitBash({ ProgramFiles: 'P:\\' }, exists, () => undefined)).toBe(
        'P:\\Git\\bin\\bash.exe',
      );
      expect(gitBash({}, exists, () => undefined)).toBeUndefined();
    },
  );

  it.runIf(process.platform === 'win32')(
    'really runs .cmd (in a folder with spaces), .ps1 and .sh tests on Windows',
    () => {
      const d = built({
        'my tests/a.cmd': '@echo off\r\necho cmd ran %FFMPEG_TARGET%\r\nexit /b 0\r\n',
        'my tests/b.ps1': 'Write-Output "ps ran $env:FFMPEG_TARGET"; exit 0\n',
        'my tests/c.sh':
          'echo "sh ran $FFMPEG_TARGET"; [ -n "$BASH_VERSION" ] && [ -z "$WSL_DISTRO_NAME" ]\n',
      });
      for (const test of ['my tests/a.cmd', 'my tests/b.ps1', 'my tests/c.sh']) {
        const how = scriptCommand(join(d, test));
        if ('error' in how) {
          throw new Error(how.error);
        }
        const r = spawnSync(how.cmd, how.args, {
          encoding: 'utf8',
          env: { ...process.env, FFMPEG_TARGET: 't' },
          windowsVerbatimArguments: how.verbatim === true,
        });
        expect(r.status, `${test}: ${r.stdout}${r.stderr}`).toBe(0);
        expect(r.stdout).toContain('ran t');
      }
    },
  );

  it("skips a build this machine can't run, and says why", async () => {
    const d = built();
    expect(
      await runTest(folderOf(d), data, {
        target: 't',
        dist: join(d, 'dist'),
        runnable: ['win-x64'],
      }),
    ).toEqual({
      output: "t: skipped, linux-x64 builds don't run on this machine (it runs win-x64)",
      exitCode: 0,
    });
  });

  it.skipIf(process.platform === 'win32')(
    "runs the smoke test and the target's tests, failing on one that fails",
    async () => {
      const pass = built({ 'tests/ok.sh': `"\${FFMPEG}" -version | grep -q 9.1.0\n` });
      const ok = await runTest(folderOf(pass), data, {
        target: 't',
        dist: join(pass, 'dist'),
        runnable: ['linux-x64'],
      });
      expect(ok.output).toContain('✓ ffmpeg -version says 9.1.0');
      expect(ok.output).toContain('✓ ffmpeg -buildconf matches lgplv3');
      expect(ok.output).toContain('✓ tests: tests/ok.sh');
      expect(ok.exitCode).toBe(0);
      const fail = built({ 'tests/bad.sh': 'echo "decoded the wrong number of frames"; exit 3\n' });
      const r = await runTest(folderOf(fail), data, {
        target: 't',
        dist: join(fail, 'dist'),
        runnable: ['linux-x64'],
      });
      expect(r.output).toContain('✗ tests: tests/bad.sh');
      expect(r.output).toContain('decoded the wrong number of frames');
      expect(r.exitCode).toBe(1);
      // a gplv3 target whose build says lgplv3's flags fails the licence check, naming what is missing
      const wrong = built({}, 'gplv3');
      const w = await runTest(folderOf(wrong), data, {
        target: 't',
        dist: join(wrong, 'dist'),
        runnable: ['linux-x64'],
      });
      expect(w.output).toContain('✗ ffmpeg -buildconf matches gplv3 (missing --enable-gpl)');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads back an MPEG-TS the build wrote: its demuxer runs in a thread of its own, which a small stack crashes',
    async () => {
      const test = async (answers: string[]) => {
        const d = built({}, 'lgplv3', answers);
        return runTest(folderOf(d), data, {
          target: 't',
          dist: join(d, 'dist'),
          runnable: ['linux-x64'],
        });
      };
      // (writes the file it is told to: the last argument)
      const wrote = '*"-f mpegts"*) for last; do :; done; : > "$last" ;;';
      const ok = await test([wrote]);
      expect(ok.output).toContain('✓ a test pattern written as MPEG-TS reads back');
      // musl's 128 KiB thread stacks, before the 8 MiB default (devenvy/ffmpeg-build#38)
      const crash = await test([wrote, '*smoke.ts*) echo "Segmentation fault"; exit 139 ;;']);
      expect(crash.output).toContain('✗ a test pattern written as MPEG-TS reads back');
      expect(crash.output).toContain('Segmentation fault');
      expect(crash.exitCode).toBe(1);
      // a build without what writing one takes (its components restricted) isn't failed for it
      const none = await test(['*"-f mpegts"*) echo "Unknown encoder \'mpeg2video\'"; exit 1 ;;']);
      expect(none.output).toContain(
        "- MPEG-TS read back not checked: the build can't write one (Unknown encoder 'mpeg2video')",
      );
      expect(none.exitCode).toBe(0);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'checks that each option its configure line has on ships its components, from the listings ffmpeg prints',
    async () => {
      const d = built({}, 'lgplv3', [
        '*-buildconf*) echo "  --disable-gpl --enable-version3 --disable-nonfree --enable-libdav1d --enable-libopus --enable-vaapi" ;;',
        '*-decoders*) printf "Decoders:\\n ------\\n V....D libdav1d   dav1d AV1 decoder\\n" ;;',
        // libopus configured, but not in the build
        '*-encoders*) printf "Encoders:\\n ------\\n A..... aac   AAC\\n" ;;',
        '*-filters*) printf "Filters:\\n ... transpose_vaapi   V->V   VAAPI transpose\\n" ;;',
        '*-hwaccels*) exit 1 ;;',
        '*resampler=soxr*) echo "Requested resampling engine is unavailable"; exit 1 ;;',
      ]);
      const r = await runTest(folderOf(d), data, {
        target: 't',
        dist: join(d, 'dist'),
        runnable: ['linux-x64'],
      });
      expect(r.output).toContain('✓ dav1d ships decoders libdav1d');
      expect(r.output).toContain(
        '✗ opus is on, but the build lacks encoders libopus, resamplers soxr',
      );
      expect(r.output).toContain('✗ ffmpeg -hwaccels lists them');
      expect(r.output).toContain('✓ vaapi ships filters transpose_vaapi');
      expect(r.output).toContain('- vaapi: hwaccels vaapi not checked: ffmpeg -hwaccels failed');
      expect(r.exitCode).toBe(1);
    },
  );

  it("runs the archive's ffmpeg with nothing pointing its loader elsewhere; PATH on Windows is Windows' own", () => {
    const env = {
      HOME: '/home/u',
      PATH: '/usr/bin',
      LD_LIBRARY_PATH: '/build/install/lib',
      DYLD_LIBRARY_PATH: '/opt/homebrew/lib',
      DYLD_FALLBACK_FRAMEWORK_PATH: '/x',
      LD_PRELOAD: '/x.so',
    };
    expect(archiveEnv(env, 'linux')).toEqual({ HOME: '/home/u', PATH: '/usr/bin' });
    expect(archiveEnv(env, 'darwin')).toEqual({ HOME: '/home/u', PATH: '/usr/bin' });
    expect(
      archiveEnv(
        {
          Path: 'C:\\msys64\\mingw64\\bin;C:\\Windows\\System32',
          SystemRoot: 'D:\\Win',
          TEMP: 'T',
        },
        'win32',
      ),
    ).toEqual({
      SystemRoot: 'D:\\Win',
      TEMP: 'T',
      PATH: 'D:\\Win\\System32;D:\\Win;D:\\Win\\System32\\Wbem',
    });
    expect(archiveEnv({}, 'win32')).toEqual({
      PATH: 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'tests the published archive, unpacked fresh: never the build folder, nor libraries the loader is pointed at',
    async () => {
      // an ffmpeg that works only when LD_LIBRARY_PATH leads it to libraries outside the archive
      const d = built(
        { 'tests/env.sh': '[ "$LD_LIBRARY_PATH" = /build/install/lib ]\n' },
        'lgplv3',
        [
          '*-version*) [ -n "$LD_LIBRARY_PATH" ] && echo "ffmpeg version 9.1.0" || { echo "libavdevice.so.62: cannot open shared object file"; exit 127; } ;;',
        ],
      );
      const r = await runTest(folderOf(d), data, {
        target: 't',
        dist: join(d, 'dist'),
        runnable: ['linux-x64'],
        env: { LD_LIBRARY_PATH: '/build/install/lib' },
      });
      expect(r.output).toContain('✗ ffmpeg -version says 9.1.0');
      expect(r.output).toContain('libavdevice.so.62: cannot open shared object file');
      // the target's own scripts get the environment as it is
      expect(r.output).toContain('✓ tests: tests/env.sh');
      // an archive without ffmpeg fails, though the folder it was packed from sits beside it
      const e = built();
      writeFileSync(
        join(e, 'dist', 'ffmpeg-9.1.0-t.tar.gz'),
        tarGz([{ name: 'THIRD-PARTY-NOTICES.txt', data: 'x', mode: 0o644 }]),
      );
      mkdirSync(join(e, 'dist', 'ffmpeg-9.1.0-t'));
      writeFileSync(join(e, 'dist', 'ffmpeg-9.1.0-t', 'ffmpeg'), '#!/bin/sh\n', { mode: 0o755 });
      const missing = await runTest(folderOf(e), data, {
        target: 't',
        dist: join(e, 'dist'),
        runnable: ['linux-x64'],
      });
      expect(missing.output).toContain('✗ no ffmpeg program in ffmpeg-9.1.0-t.tar.gz');
      expect(missing.exitCode).toBe(1);
    },
  );

  it("check refuses a tests: script that isn't there", () => {
    const d = built({});
    writeFileSync(
      join(d, 'ffmpeg-build.yml'),
      'targets:\n  t: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d], tests: [tests/missing.sh] }\n',
    );
    const r = runCli(['check'], { cwd: d, env: { FFMPEG_BUILD_DATA: fixtureEngineRoot } });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      '✗ tests: tests/missing.sh: no such file (ffmpeg-build test runs it against the build)',
    );
  });
});
