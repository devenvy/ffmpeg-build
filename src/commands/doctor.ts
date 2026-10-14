// `ffmpeg-build doctor`: is this machine ready to build (and test) these targets? For each target it works out how it
// builds here (in Docker, natively, or with Xcode on a Mac) and how `test` would run it, then checks what that needs
// and says how to install what is missing, for this host: its Linux distribution's package manager, the MSYS2
// environment, Homebrew. Offline and quick: it only asks the local tools (no builds, no network).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dockerCommand } from '../build/docker.ts';
import {
  brewPackages,
  currentHost,
  dockerInstall,
  dockerStart,
  type Host,
  hostSummary,
  installHint,
  missingTools,
  msys2Environment,
  nativeKind,
  nativeTools,
} from '../build/host.ts';
import { hostEnv } from '../build/native.ts';
import { type BuildIn, buildSettings, defaultIn, isApple } from '../build-settings.ts';
import { LOCK_FILE, readFolderLock } from '../lockfile.ts';
import { describePlatforms, expandPlatformPattern, expandPlatforms } from '../platforms.ts';
import { planProfile } from '../resolve.ts';
import { selectTargets } from '../select.ts';
import { type Folder, FOLDER_FILE, type Target, targetProfile } from '../targets.ts';
import { JSON_INDENT } from '../text.ts';
import { FolderError, jsonFailure } from './folder.ts';
import { androidNdk, cannotLink, LIBRARY_PLATFORM } from './test-library.ts';
import { BINFMT, containerFor, gitBash, runnablePlatforms } from './test.ts';

import type { EngineData } from '../engine-data.ts';

/** What doctor asks of this machine; the tests pass their own. */
export interface DoctorEnv {
  host: Host;
  env: NodeJS.ProcessEnv;
  /** runs a local command: whether it exited 0, what it printed, and whether it couldn't start at all */
  run: (cmd: string, args: string[]) => { ok: boolean; out: string; missing: boolean };
  /** the tools that aren't on PATH */
  missingTools: (tools: readonly string[]) => string[];
  exists: (path: string) => boolean;
  /** whether a platform's toolchain image is an arm64 one */
  arm64Image: (platform: string) => boolean;
  /** the Homebrew packages an Apple build needs (platforms/apple-brew.txt) */
  brewWanted: string[];
  /** writes a file for a probe to read (glslc's test shader), and says where */
  writeProbe: (name: string, text: string) => string;
}

interface Need {
  what: string;
  ok: boolean;
  have?: string;
  install?: string;
  /** reported, but its absence doesn't stop anything (test does less without it) */
  optional?: true;
}

interface TargetReport {
  name: string;
  platform: string;
  buildsIn: BuildIn | null;
  cantBuild?: string;
  testsIn: 'here' | 'docker' | null;
  cantTest?: string;
  needs: Need[];
}

interface Result {
  output: string;
  exitCode: number;
}

/** A local command's run, short: no command doctor runs takes long unless something is wrong. */
const PROBE_TIMEOUT_MS = 15_000;

/** This machine, as doctor sees it. */
export function realDoctorEnv(data: EngineData, engineRoot: string): DoctorEnv {
  const env = hostEnv();
  return {
    host: currentHost(),
    env: process.env,
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, {
        encoding: 'utf8',
        timeout: PROBE_TIMEOUT_MS,
        env: process.env,
      });
      return {
        ok: r.status === 0,
        // a command that can't start has no output at all
        out: [r.stdout, r.stderr].filter(Boolean).join(''),
        missing: (r.error as { code?: string } | undefined)?.code === 'ENOENT',
      };
    },
    missingTools: (tools) => missingTools(tools, env),
    exists: existsSync,
    arm64Image: (platform) => {
      const image = data.platforms.get(platform)?.image;
      try {
        return (
          image !== undefined &&
          /^FROM\s+--platform=linux\/arm64\b/m.test(
            readFileSync(join(engineRoot, 'images', image, 'Dockerfile'), 'utf8'),
          )
        );
      } catch {
        return false; // macos: no image
      }
    },
    brewWanted: brewPackages(readFileSync(join(engineRoot, 'platforms', 'apple-brew.txt'), 'utf8')),
    writeProbe: (name, text) => {
      const path = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-doctor-')), name);
      writeFileSync(path, text);
      return path;
    },
  };
}

const firstLine = (s: string): string => s.split('\n')[0]!.trim();

/** What each check found, asked once per run (several targets need Docker). */
function prober(e: DoctorEnv): {
  docker: () => Need;
  version: (cmd: string, args: string[]) => string | undefined;
} {
  let docker: Need | undefined;
  const version = (cmd: string, args: string[]) => {
    const r = e.run(cmd, args);
    return r.ok ? firstLine(r.out) : undefined;
  };
  return {
    version,
    docker: () => {
      docker ??= dockerNeed(e);
      return docker;
    },
  };
}

function dockerNeed(e: DoctorEnv): Need {
  const r = e.run(dockerCommand(), ['version', '--format', '{{.Server.Version}}']);
  if (r.ok) {
    return { what: 'Docker', ok: true, have: firstLine(r.out) };
  }
  if (r.missing) {
    return { what: 'Docker is not installed', ok: false, install: dockerInstall(e.host) };
  }
  if (/permission denied/i.test(r.out)) {
    return {
      what: "Docker is running, but this user can't use it",
      ok: false,
      install: 'sudo usermod -aG docker $USER, then log in again',
    };
  }
  return { what: 'Docker is installed but not running', ok: false, install: dockerStart(e.host) };
}

/** qemu registered with the kernel, so Docker on this Linux machine runs another CPU's containers. */
function binfmtNeed(e: DoctorEnv, what: string, name: string, install: string): Need {
  return e.exists(`/proc/sys/fs/binfmt_misc/${name}`)
    ? { what, ok: true }
    : { what, ok: false, install: `docker run --privileged --rm ${BINFMT} --install ${install}` };
}

const XCODE_INSTALL =
  'install Xcode (App Store), then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer';
const HOMEBREW_INSTALL =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
const BREW_WHAT = 'Homebrew build tools (platforms/apple-brew.txt)';

function appleNeeds(e: DoctorEnv, probe: ReturnType<typeof prober>): Need[] {
  const needs: Need[] = [];
  const selected = probe.version('xcode-select', ['-p']);
  const xcode = probe.version('xcodebuild', ['-version']);
  if (xcode) {
    needs.push({ what: 'Xcode', ok: true, have: xcode });
  } else {
    needs.push({
      what: selected ? 'Xcode (only the Command Line Tools are selected)' : 'Xcode',
      ok: false,
      install: XCODE_INSTALL,
    });
  }
  const brew = probe.version('brew', ['--version']);
  if (!brew) {
    needs.push({
      what: 'Homebrew',
      ok: false,
      install: `${HOMEBREW_INSTALL}, then: brew install ${e.brewWanted.join(' ')}`,
    });
    return needs;
  }
  const listed = e.run('brew', ['list', '--formula', '-1']);
  const installed = new Set(listed.ok ? listed.out.split('\n').map((l) => l.trim()) : []);
  const missing = e.brewWanted.filter((p) => !installed.has(p));
  needs.push(
    missing.length
      ? {
          what: `${BREW_WHAT}: ${missing.join(', ')} missing`,
          ok: false,
          install: `brew install ${missing.join(' ')}`,
        }
      : { what: BREW_WHAT, ok: true, have: brew },
  );
  return needs;
}

/** A native Linux or MSYS2 build's tools, with the compiler's version when they are all there. */
function toolNeeds(
  e: DoctorEnv,
  probe: ReturnType<typeof prober>,
  kind: 'linux' | 'windows',
  platform: string,
): Need {
  const tools = nativeTools(kind, platform, e.host.msystem);
  const missing = e.missingTools(tools);
  if (missing.length) {
    return {
      what: `native build tools: ${missing.join(', ')} missing`,
      ok: false,
      install: installHint(kind, e.host, missing),
    };
  }
  const compiler = tools.includes('clang') ? 'clang' : 'gcc';
  const have = probe.version(compiler, ['--version']);
  return { what: 'native build tools', ok: true, ...(have ? { have } : {}) };
}

/** How a platform builds here, and what that needs; or why it can't. */
function buildNeeds(
  e: DoctorEnv,
  probe: ReturnType<typeof prober>,
  platform: string,
  way: BuildIn,
  shaders?: string,
): Pick<TargetReport, 'buildsIn' | 'cantBuild'> & { needs: Need[] } {
  if (way === 'docker') {
    if (isApple(platform)) {
      return {
        buildsIn: null,
        cantBuild: `${platform} builds only on a Mac, with Xcode; it has no Docker build (drop in: docker)`,
        needs: [],
      };
    }
    const needs = [probe.docker()];
    if (e.arm64Image(platform) && e.host.os === 'linux' && e.host.arch === 'x64') {
      needs.push(
        binfmtNeed(e, 'qemu for arm64 containers (binfmt qemu-aarch64)', 'qemu-aarch64', 'arm64'),
      );
    }
    return { buildsIn: 'docker', needs };
  }
  const native = nativeKind(platform, e.host);
  if ('error' in native) {
    // Windows outside the MSYS2 shell it needs: say which, and what to install in it
    const msystem = e.host.os === 'win32' ? msys2Environment(platform, e.host) : undefined;
    if (!msystem) {
      return { buildsIn: null, cantBuild: native.error, needs: [] };
    }
    const pacman = installHint('windows', { ...e.host, msystem }).replace(
      /^in the MSYS2 shell: /,
      '',
    );
    return {
      buildsIn: null,
      cantBuild: native.error,
      needs: [
        {
          what: `an MSYS2 ${msystem} shell`,
          ok: false,
          ...(e.host.msystem
            ? { have: e.host.gitBash ? 'Git Bash (not MSYS2)' : `MSYSTEM=${e.host.msystem}` }
            : {}),
          install: `install MSYS2 (winget install MSYS2.MSYS2), open its ${msystem} shell, run ffmpeg-build from there, and in it: ${pacman}`,
        },
      ],
    };
  }
  if (native.kind === 'apple') {
    return { buildsIn: 'here', needs: appleNeeds(e, probe) };
  }
  return {
    buildsIn: 'here',
    needs: [
      toolNeeds(e, probe, native.kind, platform),
      ...(shaders === undefined ? [] : [glslcNeed(e, native.kind, shaders)]),
    ],
  };
}

// FFmpeg's spirv_compiler probe (8.1 and later): a glslc that predates Vulkan 1.4 fails it, and configure then drops
// every Vulkan filter without a word (images/linux-x64/Dockerfile asserts the same)
const PROBE_SHADER = '#version 460\nlayout (local_size_x = 1) in;\nvoid main() {}\n';
const VULKAN_14 = [
  '--target-env=vulkan1.4',
  '--target-spv=spv1.6',
  '-std=460',
  '-fshader-stage=compute',
];
/** FFmpeg's first release whose configure asks glslc for Vulkan 1.4. */
const VULKAN_14_FFMPEG = { major: 8, minor: 1 };

/** Whether this FFmpeg (a release, or a series: its newest) probes glslc for Vulkan 1.4. */
export function wantsVulkan14(ffmpeg: string): boolean {
  const [major = 0, minor] = ffmpeg.split('.').map(Number);
  const { major: m, minor: n } = VULKAN_14_FFMPEG;
  return major > m || (major === m && (minor === undefined || minor >= n));
}

/** glslc, for a build that compiles Vulkan shaders: there, and (for FFmpeg 8.1+) able to target Vulkan 1.4. */
function glslcNeed(e: DoctorEnv, kind: 'linux' | 'windows', ffmpeg: string): Need {
  const install = installHint(kind, e.host, ['glslc']);
  const version = e.run('glslc', ['--version']);
  if (!version.ok) {
    return { what: 'glslc (Vulkan shaders)', ok: false, install };
  }
  const have = version.out.split('\n')[0]!.trim();
  if (!wantsVulkan14(ffmpeg)) {
    return { what: 'glslc (Vulkan shaders)', ok: true, have };
  }
  const shader = e.writeProbe('probe.comp', PROBE_SHADER);
  const probe = e.run('glslc', [...VULKAN_14, shader, '-o', `${shader}.spv`]);
  return probe.ok
    ? { what: 'glslc (Vulkan 1.4 shaders)', ok: true, have }
    : {
        what: 'glslc too old for Vulkan 1.4',
        ok: false,
        have,
        install: `a newer glslc: ${install}, if the distribution's is new enough; else build shaderc's glslc, as images/linux-x64/Dockerfile does`,
      };
}

/**
 * When a target's build compiles Vulkan shaders, the FFmpeg it builds (its locked release, else its series); else
 * undefined. FFmpeg's Vulkan options (vulkan, placebo, shaderc) do, and so does whisper.cpp where its ggml Vulkan
 * backend is in: with the Vulkan loader (Linux) or the shim (Windows) in the build, from its resolved plan.
 */
export function vulkanShaders(folder: Folder, t: Target, data: EngineData): string | undefined {
  const version = readFolderLock(join(folder.dir, LOCK_FILE))?.ffmpeg[t.ffmpeg];
  const cell = planProfile(targetProfile(folder, t), data, version ? { [t.ffmpeg]: version } : {})
    .cells[0];
  if (!cell) {
    return undefined;
  }
  const options = cell.options.some((o) => ['vulkan', 'placebo', 'shaderc'].includes(o));
  const whisper =
    cell.recipes.includes('whisper.cpp') &&
    (cell.recipes.includes('vulkan-loader') || cell.recipes.includes('vulkan-shim'));
  return options || whisper ? (version ?? t.ffmpeg) : undefined;
}

const ROSETTA: Need = {
  what: 'Rosetta (runs x86_64 builds)',
  ok: false,
  install: 'softwareupdate --install-rosetta --agree-to-license',
};

/** How `test` runs a platform's build here, and what that needs; or why it can't. */
function testNeeds(
  e: DoctorEnv,
  probe: ReturnType<typeof prober>,
  platform: string,
  tests: readonly string[],
): Pick<TargetReport, 'testsIn' | 'cantTest'> & { needs: Need[] } {
  const appleSilicon = e.host.os === 'darwin' && e.host.arch === 'arm64';
  const rosetta = appleSilicon && e.run('arch', ['-x86_64', '/usr/bin/true']).ok;
  const runnable = runnablePlatforms(
    e.host.os,
    e.host.arch as NodeJS.Architecture,
    e.host.musl,
    rosetta,
  );
  if (LIBRARY_PLATFORM.test(platform)) {
    return libraryTestNeeds(e, probe, platform, appleSilicon && !rosetta);
  }
  if (runnable.includes(platform)) {
    return { testsIn: 'here', needs: scriptNeeds(e, probe, tests) };
  }
  if (appleSilicon && runnablePlatforms('darwin', 'arm64', false, true).includes(platform)) {
    return { testsIn: 'here', needs: [ROSETTA, ...scriptNeeds(e, probe, tests)] };
  }
  const container = containerFor(platform, runnable);
  if (!container) {
    return {
      testsIn: null,
      cantTest: `${platform} builds don't run on this machine (it runs ${runnable.join(', ') || 'none of the build platforms'})`,
      needs: [],
    };
  }
  const needs = [probe.docker()];
  if (container.dockerPlatform === 'linux/arm/v7' && e.host.arch === 'x64') {
    needs.push(
      binfmtNeed(e, 'qemu for 32-bit ARM containers (binfmt qemu-arm)', 'qemu-arm', 'arm'),
    );
  }
  return { testsIn: 'docker', needs };
}

function libraryTestNeeds(
  e: DoctorEnv,
  probe: ReturnType<typeof prober>,
  platform: string,
  noRosetta: boolean,
): Pick<TargetReport, 'testsIn' | 'cantTest'> & { needs: Need[] } {
  if (platform.startsWith('android-')) {
    if (e.host.os === 'win32') {
      return { testsIn: null, cantTest: cannotLink(platform, 'win32', {})!, needs: [] };
    }
    const ndk = androidNdk(e.env, e.exists);
    const adb = probe.version('adb', ['version']);
    return {
      testsIn: 'here',
      needs: [
        ndk
          ? { what: 'the Android NDK (ANDROID_NDK_HOME)', ok: true, have: ndk }
          : {
              what: 'the Android NDK (ANDROID_NDK_HOME)',
              ok: false,
              install:
                "install the NDK (Android Studio's SDK Manager, or https://developer.android.com/ndk/downloads) and set ANDROID_NDK_HOME to its folder",
            },
        adb
          ? { what: 'adb (runs the test program on a device or emulator)', ok: true, have: adb }
          : {
              what: 'adb (runs the test program on a device or emulator)',
              ok: false,
              optional: true,
              install:
                'install the Android SDK platform-tools and start a device or emulator; without them, test only links',
            },
      ],
    };
  }
  if (e.host.os !== 'darwin') {
    return { testsIn: null, cantTest: cannotLink(platform, e.host.os, {})!, needs: [] };
  }
  const clang = probe.version('xcrun', ['--find', 'clang']);
  const needs: Need[] = [
    clang
      ? { what: "Xcode's clang (xcrun)", ok: true, have: clang }
      : { what: "Xcode's clang (xcrun)", ok: false, install: XCODE_INSTALL },
  ];
  if (platform === 'maccatalyst-x64' && noRosetta) {
    needs.push({ ...ROSETTA, optional: true });
  }
  return { testsIn: 'here', needs };
}

/** What runs a target's own tests: Git Bash for .sh on Windows, bash elsewhere. */
function scriptNeeds(
  e: DoctorEnv,
  probe: ReturnType<typeof prober>,
  tests: readonly string[],
): Need[] {
  if (!tests.some((t) => t.toLowerCase().endsWith('.sh'))) {
    return [];
  }
  if (e.host.os === 'win32') {
    const bash = gitBash(e.env, e.exists, () => probe.version('git', ['--exec-path']));
    return [
      bash
        ? { what: 'Git Bash (runs the .sh tests)', ok: true, have: bash }
        : {
            what: 'Git Bash (runs the .sh tests)',
            ok: false,
            install:
              'install Git for Windows (winget install Git.Git), or set BASH to its bash.exe',
          },
    ];
  }
  const bash = probe.version('bash', ['--version']);
  return [
    bash
      ? { what: 'bash (runs the .sh tests)', ok: true, have: bash }
      : { what: 'bash (runs the .sh tests)', ok: false },
  ];
}

const GIT_WHAT = 'git (lock and update)';

function gitNeed(e: DoctorEnv, probe: ReturnType<typeof prober>): Need {
  const v = probe.version('git', ['--version']);
  if (v) {
    return { what: GIT_WHAT, ok: true, have: v.replace(/^git version /, '') };
  }
  let install: string;
  if (e.host.os === 'win32') {
    install = 'winget install Git.Git';
  } else if (e.host.os === 'darwin') {
    install = 'xcode-select --install (or brew install git)';
  } else {
    install = installHint('linux', e.host, ['git']);
  }
  return { what: GIT_WHAT, ok: false, install };
}

/** Each need once, in order (Docker for both the build and the test is one need). */
const unique = (needs: Need[]): Need[] =>
  needs.filter((n, i) => needs.findIndex((m) => m.what === n.what) === i);

const ready = (t: TargetReport): boolean =>
  t.buildsIn !== null && t.testsIn !== null && t.needs.every((n) => n.ok || n.optional);

const withShaders = (ffmpeg: string | undefined) => (ffmpeg ? { shaders: ffmpeg } : {});

/** The targets doctor looks at: the folder's (or those chosen), else the --platform list's platforms. */
function chosenTargets(
  input: DoctorInput,
): { name: string; platform: string; in: BuildIn; tests: string[]; shaders?: string }[] {
  if (input.folder) {
    const { folder } = input;
    return selectTargets(folder, {
      ...(input.target !== undefined ? { target: input.target } : {}),
      ...(input.platform !== undefined ? { platform: input.platform } : {}),
    }).map((t) => ({
      name: t.name,
      platform: t.platform,
      in: buildSettings(folder, t.platform).in ?? defaultIn(t.platform),
      tests: t.tests,
      ...withShaders(input.shaders?.(t)),
    }));
  }
  if (input.target !== undefined) {
    throw new FolderError(
      `no ${FOLDER_FILE} here: --target needs one (--platform <patterns> checks platforms without it)`,
    );
  }
  if (input.platform === undefined) {
    throw new FolderError(
      `no ${FOLDER_FILE} here: say which platforms to check with --platform <patterns>`,
    );
  }
  const patterns = input.platform
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const bad = patterns.filter((p) => !expandPlatformPattern(p).length);
  if (!patterns.length || bad.length) {
    throw new FolderError(
      `--platform: ${bad.join(', ') || input.platform} names no platform ffmpeg-build knows`,
    );
  }
  return expandPlatforms(patterns).map((p) => ({
    name: p,
    platform: p,
    in: defaultIn(p),
    tests: [],
  }));
}

interface DoctorInput {
  folder?: Folder;
  /** whether a target's build compiles Vulkan shaders (vulkanShaders), and for which FFmpeg */
  shaders?: (t: Target) => string | undefined;
  target?: string;
  platform?: string;
  json?: boolean;
}

const READY = 'ready: every target builds and tests here';
const plural = (n: number, what: string): string => `${n} ${what}${n === 1 ? '' : 's'}`;

export function runDoctor(input: DoctorInput, e: DoctorEnv): Result {
  const chosen = chosenTargets(input);
  const probe = prober(e);
  const needs = [gitNeed(e, probe)];
  const targets: TargetReport[] = chosen.map((t) => {
    const build = buildNeeds(e, probe, t.platform, t.in, t.shaders);
    const test = testNeeds(e, probe, t.platform, t.tests);
    return {
      name: t.name,
      platform: t.platform,
      buildsIn: build.buildsIn,
      ...(build.cantBuild ? { cantBuild: build.cantBuild } : {}),
      testsIn: test.testsIn,
      ...(test.cantTest ? { cantTest: test.cantTest } : {}),
      needs: unique([...build.needs, ...test.needs]),
    };
  });
  const notReady = targets.filter((t) => !ready(t));
  const problems = [
    ...needs.filter((n) => !n.ok).map((n) => n.what),
    ...notReady.flatMap((t) => [
      ...(t.cantBuild ? [`${t.name}: can't build here: ${t.cantBuild}`] : []),
      ...(t.cantTest ? [`${t.name}: can't test here: ${t.cantTest}`] : []),
      ...t.needs.filter((n) => !n.ok && !n.optional).map((n) => `${t.name}: ${n.what}`),
    ]),
  ];
  const host = hostSummary(e.host);
  const exitCode = problems.length ? 1 : 0;
  const summary = notReady.length
    ? `${notReady.length} of ${targets.length} target${targets.length === 1 ? '' : 's'} ${notReady.length === 1 ? "isn't" : "aren't"} ready here`
    : "this machine isn't ready";
  if (input.json) {
    return {
      output: exitCode
        ? jsonFailure(summary, problems, { ok: false, host, needs, targets })
        : JSON.stringify({ ok: true, host, needs, targets }, null, JSON_INDENT),
      exitCode,
    };
  }
  const lines = [`this machine: ${host}`, ...needs.flatMap((n) => needLines(n)), ''];
  if (targets.length === 1) {
    // one target: its own list
    const [t] = targets as [TargetReport];
    lines.push(`${t.name} (${t.platform}): ${how(t)}`, ...t.needs.flatMap((n) => needLines(n)));
    lines.push('', exitCode ? summary : READY);
  } else {
    // many: each requirement once, with the targets that need it
    const groups = grouped(targets);
    const missing = needs.filter((n) => !n.ok).length + groups.missing;
    lines.push(
      ...groups.lines,
      '',
      exitCode
        ? `${plural(missing, 'thing')} missing${notReady.length ? ` for ${plural(notReady.length, 'target')}` : ''}`
        : READY,
    );
  }
  return { output: lines.join('\n'), exitCode };
}

/** Some targets, in few words: how many, and their platforms as patterns (`android-*, linux-x64`). */
const which = (ts: readonly TargetReport[]): string =>
  `${plural(ts.length, 'target')}: ${describePlatforms([...new Set(ts.map((t) => t.platform))])}`;

// how a need is shown, in the order they are listed: what's missing, what's optional, what's there
const MARKS = ['✗', '-', '✓'] as const;
const MISSING = 0;
const rank = (n: Need): number => {
  if (n.ok) {
    return MARKS.indexOf('✓');
  }
  return n.optional ? MARKS.indexOf('-') : MISSING;
};

/**
 * The requirements of many targets, each once: first what stops targets outright (can't build or test here, grouped
 * by reason), then what is missing, then what is optional, then what is there.
 */
function grouped(targets: readonly TargetReport[]): { lines: string[]; missing: number } {
  const cant = new Map<
    string,
    { verb: string; reason: string; platform: string; targets: TargetReport[] }
  >();
  const add = (verb: string, t: TargetReport, reason: string | undefined) => {
    if (reason === undefined) {
      return;
    }
    // the same reason for another platform is the same reason (it names the target's platform first)
    const key = `${verb}\0${reason.replace(t.platform, '\0')}`;
    const group = cant.get(key) ?? { verb, reason, platform: t.platform, targets: [] };
    group.targets.push(t);
    cant.set(key, group);
  };
  const needs = new Map<string, { need: Need; targets: TargetReport[] }>();
  for (const t of targets) {
    add('build', t, t.cantBuild);
    add('test', t, t.cantTest);
    for (const n of t.needs) {
      const key = JSON.stringify(n);
      const group = needs.get(key) ?? { need: n, targets: [] };
      group.targets.push(t);
      needs.set(key, group);
    }
  }
  const lines = [
    ...[...cant.values()].map((g) => {
      const platforms = describePlatforms([...new Set(g.targets.map((t) => t.platform))]);
      return `  ✗ ${plural(g.targets.length, 'target')} can't ${g.verb} here: ${g.reason.replace(g.platform, platforms)}`;
    }),
    ...[...needs.values()]
      .sort((a, b) => rank(a.need) - rank(b.need))
      .flatMap((g) => needLines(g.need, ` (${which(g.targets)})`)),
  ];
  return {
    lines,
    missing: cant.size + [...needs.values()].filter((g) => rank(g.need) === MISSING).length,
  };
}

function how(t: TargetReport): string {
  const build =
    t.buildsIn === null
      ? `can't build here: ${t.cantBuild ?? ''}`
      : `builds ${t.buildsIn === 'docker' ? 'in Docker' : 'here'}`;
  if (t.testsIn === null) {
    return `${build}; can't test here: ${t.cantTest ?? ''}`;
  }
  return `${build}, tests ${t.testsIn === 'docker' ? 'in Docker' : 'here'}`;
}

function needLines(n: Need, suffix = ''): string[] {
  const mark = MARKS[rank(n)]!;
  const text = n.ok && n.have ? `${n.what}: ${n.have}` : n.what;
  return [`  ${mark} ${text}${suffix}`, ...(!n.ok && n.install ? [`      ${n.install}`] : [])];
}
