// `ffmpeg-build test --target <name>`: runs a target's build where this machine can run it. A smoke test first (the
// programs start, their configure line is the plan's, a short encode works, each option on ships what it adds:
// shipped.ts), then each script the target lists in
// `tests:`, with FFMPEG, FFPROBE and FFMPEG_DIR set. A build this machine can't run is skipped and says why (with
// --must-run, it fails). On a glibc Linux machine with Docker, a musl build of its architecture runs in a plain Alpine
// container and a linux-armhf build in a Debian armhf one (the images their toolchains start from, pinned by the same
// digests; armhf under qemu where the CPU can't run 32-bit ARM). A build of libraries only (Android, iOS, Mac
// Catalyst) is tested by linking a small program against it and running that where it can (test-library.ts).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';

import { DOCTOR_HINT } from '../build/host.ts';
import { LICENSE_FLAGS } from '../build/plan.ts';
import { profileAdditions } from '../check.ts';
import { LOCK_FILE, readFolderLock } from '../lockfile.ts';
import { packageRoot } from '../paths.ts';
import { artifactName, type Folder, FOLDER_FILE, type Target, targetProfile } from '../targets.ts';
import { extractTarGzFile } from '../untar.ts';
import { FolderError } from './folder.ts';
import { expectedComponents, type Has, listedAs, listedNames, shippedSteps } from './shipped.ts';
import { scriptEnv, targetTestEnv } from './test-env.ts';
import { cannotLink, LIBRARY_PLATFORM, testLibrary } from './test-library.ts';

import type { EngineData } from '../engine-data.ts';
import type { ShippedKind } from '../schema/engine.ts';

const KIB = 1024;
const MAX_OUTPUT_MIB = 64;
/** The most a command run by `test` may print. */
export const MAX_OUTPUT = MAX_OUTPUT_MIB * KIB * KIB;
/** How many of a failed check's last lines of output its report shows. */
const DETAIL_TAIL_LINES = 15;

/** What a spawnSync'd command printed, stdout then stderr: neither is there when the command couldn't start. */
export const spawnOutput = (r: { stdout: string | null; stderr: string | null }): string =>
  `${r.stdout ?? ''}${r.stderr ?? ''}`;

interface Result {
  output: string;
  exitCode: number;
}

/** Whether this Linux machine's C library is musl: Node's report names the glibc it runs on, and none on musl. */
export function isMusl(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  const report = process.report.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

/**
 * This machine as a platform, and the platforms it can also run: a Mac runs Mac Catalyst builds as its own processes
 * and arm64 iOS simulator builds in the simulator, Rosetta runs x86_64 ones on Apple silicon, Windows on Arm emulates
 * x64. Containers (containerFor) and Android devices come on top.
 */
export function runnablePlatforms(
  platform = process.platform,
  arch = process.arch,
  musl = isMusl(),
  rosetta = hasRosetta(),
): string[] {
  if (platform === 'linux' && arch === 'x64') {
    return [musl ? 'linux-musl-x64' : 'linux-x64'];
  }
  if (platform === 'linux' && arch === 'arm64') {
    return [musl ? 'linux-musl-arm64' : 'linux-arm64'];
  }
  if (platform === 'linux' && arch === 'arm') {
    return musl ? [] : ['linux-armhf'];
  } // there is no musl armhf build
  if (platform === 'darwin' && arch === 'arm64') {
    return [
      'osx-arm64',
      'maccatalyst-arm64',
      'ios-sim-arm64',
      ...(rosetta ? ['osx-x64', 'maccatalyst-x64'] : []),
    ];
  }
  if (platform === 'darwin' && arch === 'x64') {
    return ['osx-x64', 'maccatalyst-x64'];
  }
  if (platform === 'win32' && arch === 'x64') {
    return ['win-x64'];
  }
  if (platform === 'win32' && arch === 'arm64') {
    return ['win-arm64', 'win-x64'];
  }
  return [];
}

/** The OS of a machine that runs these platforms. */
function hostOf(runnable: string[]): NodeJS.Platform | undefined {
  if (runnable.some((p) => p.startsWith('osx-'))) {
    return 'darwin';
  }
  if (runnable.some((p) => p.startsWith('win-'))) {
    return 'win32';
  }
  return runnable.some((p) => p.startsWith('linux-')) ? 'linux' : undefined;
}

export interface Container {
  image: string;
  dockerPlatform: string;
  bash: 'apk' | 'present';
}

/**
 * The container a glibc Linux machine with Docker runs another Linux platform's build in: musl builds of its own
 * architecture in Alpine, and linux-armhf in Debian armhf (under qemu on x64; GitHub's arm64 runners can't run 32-bit
 * ARM natively either). `image` is the images/ folder whose FROM is the container's image.
 */
export function containerFor(platform: string, runnable: string[]): Container | undefined {
  if (platform === 'linux-musl-x64' && runnable.includes('linux-x64')) {
    return { image: 'linux-musl-x64', dockerPlatform: 'linux/amd64', bash: 'apk' };
  }
  if (platform === 'linux-musl-arm64' && runnable.includes('linux-arm64')) {
    return { image: 'linux-musl-arm64', dockerPlatform: 'linux/arm64', bash: 'apk' };
  }
  if (
    platform === 'linux-armhf' &&
    (runnable.includes('linux-x64') || runnable.includes('linux-arm64'))
  ) {
    return { image: 'cross-armhf', dockerPlatform: 'linux/arm/v7', bash: 'present' };
  }
  return undefined;
}

/** The qemu that runs arm64 builds on x64 hosts (docs/building.md); `--install arm` lets Docker start armhf containers. */
export const BINFMT =
  'mirror.gcr.io/tonistiigi/binfmt:qemu-v8.1.5@sha256:2d2918e86e5327d0661f7083d67a95280b0f7be8f77ed79a8418f81d7d90ce6f';

function hasRosetta(): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }
  return spawnSync('arch', ['-x86_64', '/usr/bin/true']).status === 0;
}

/** The image a toolchain image starts from (images/<name>/Dockerfile's FROM, digest and all). */
export function baseImage(name: string, engineRoot = packageRoot): string {
  const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+@sha256:[0-9a-f]{64})/m.exec(
    readFileSync(join(engineRoot, 'images', name, 'Dockerfile'), 'utf8'),
  )?.[1];
  if (!from) {
    throw new FolderError(`images/${name}/Dockerfile has no FROM pinned by digest`);
  }
  return from;
}

/** The Alpine image linux-musl-x64 builds from. */
export const muslImage = (engineRoot = packageRoot): string =>
  baseImage('linux-musl-x64', engineRoot);

const dockerWorks = (): boolean =>
  spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' })
    .status === 0;
/** Whether Docker starts a container of this platform here (armhf needs a CPU with AArch32, or qemu registered). */
const dockerRuns = (image: string, platform: string) =>
  spawnSync('docker', ['run', '--rm', '--network', 'none', '--platform', platform, image, 'true'], {
    stdio: 'ignore',
  }).status === 0;

/**
 * Git Bash on Windows (never WSL's bash.exe, which PATH often finds first): $BASH when it is a file, else the bash
 * beside `git --exec-path`'s Git install, else the usual install folders.
 */
export function gitBash(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  gitExecPath: () => string | undefined = defaultGitExecPath,
): string | undefined {
  const candidates: string[] = [];
  if (env['BASH']) {
    candidates.push(env['BASH']);
  }
  const exec = gitExecPath();
  // <git>/mingw64/libexec/git-core: bash is <git>/bin/bash.exe; some layouts keep git-core two levels down
  if (exec) {
    candidates.push(
      resolve(exec, '..', '..', '..', 'bin', 'bash.exe'),
      resolve(exec, '..', '..', 'bin', 'bash.exe'),
    );
  }
  for (const base of [
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
    env['LOCALAPPDATA'] && join(env['LOCALAPPDATA'], 'Programs'),
  ]) {
    if (base) {
      candidates.push(join(base, 'Git', 'bin', 'bash.exe'));
    }
  }
  return candidates.find(
    (c) =>
      !/[\\/]system32[\\/]bash\.exe$/i.test(c) && !/[\\/]WindowsApps[\\/]/i.test(c) && exists(c),
  );
}

function defaultGitExecPath(): string | undefined {
  const r = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** How a test script runs on this host: .sh with bash (Git Bash on Windows), .cmd/.bat with cmd, .ps1 with PowerShell. */
export function scriptCommand(
  script: string,
  host: NodeJS.Platform = process.platform,
  find: { bash?: () => string | undefined; pwsh?: () => string | undefined } = {},
): { cmd: string; args: string[]; verbatim?: true } | { error: string } {
  const ext = extname(script).toLowerCase();
  if (host !== 'win32') {
    return { cmd: 'bash', args: [script] };
  }
  // verbatim: /s takes off the outer quotes, leaving the path quoted however many spaces it has
  if (ext === '.cmd' || ext === '.bat') {
    return {
      cmd: process.env['ComSpec'] ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `""${script}""`],
      verbatim: true,
    };
  }
  if (ext === '.ps1') {
    const ps = (find.pwsh ?? defaultPowerShell)();
    return ps
      ? { cmd: ps, args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] }
      : { error: 'needs PowerShell: neither pwsh nor powershell is on PATH' };
  }
  if (ext === '.sh') {
    const bash = (find.bash ?? gitBash)();
    return bash
      ? { cmd: bash, args: [script] }
      : {
          error: `needs Git Bash, which isn't found: install Git for Windows, or set BASH to its bash.exe (WSL's bash isn't used; ${DOCTOR_HINT})`,
        };
  }
  return { cmd: script, args: [] };
}

function defaultPowerShell(): string | undefined {
  return ['pwsh', 'powershell'].find(
    (p) => spawnSync(p, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0,
  );
}

/** `docker run` arguments that run `cmd` in a test container with the build and the folder mounted at their own paths. */
export function dockerArgs(
  image: string,
  mounts: string[],
  cwd: string,
  env: Record<string, string>,
  cmd: string,
  args: string[],
  network = false,
  platform?: string,
  /** variables passed by name (`-e NAME`): docker takes each value from its own environment, off its command line */
  pass: readonly string[] = [],
): string[] {
  return [
    'run',
    '--rm',
    ...(network ? [] : ['--network', 'none']),
    ...(platform ? ['--platform', platform] : []),
    ...mounts.flatMap((m) => ['-v', `${m}:${m}:ro`]),
    '-w',
    cwd,
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...pass.flatMap((k) => ['-e', k]),
    image,
    cmd,
    ...args,
  ];
}

/** What makes a loader look for libraries outside a program's own folder and run path. */
const LOADER_VARIABLES = new Set([
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'DYLD_LIBRARY_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  'DYLD_INSERT_LIBRARIES',
]);

/**
 * The environment the unpacked archive's ffmpeg runs in: without what would lead the loader to libraries outside the
 * archive, so a library the archive lacks, or a run path or install name that points elsewhere, fails here as it would
 * for whoever unpacks it. On Windows a program's DLLs are found in its own folder, then on PATH: PATH is only Windows'
 * own folders.
 */
export function archiveEnv(
  env: NodeJS.ProcessEnv,
  host: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const windows = host === 'win32';
  // Windows' variable names are any case
  const kept = Object.entries(env).filter(
    ([k]) => !LOADER_VARIABLES.has(k.toUpperCase()) && !(windows && k.toUpperCase() === 'PATH'),
  );
  if (!windows) {
    return Object.fromEntries(kept);
  }
  const root =
    Object.entries(env).find(([k]) => k.toUpperCase() === 'SYSTEMROOT')?.[1] ?? 'C:\\Windows';
  return Object.fromEntries([
    ...kept,
    ['PATH', [`${root}\\System32`, root, `${root}\\System32\\Wbem`].join(';')],
  ]);
}

/** The program `name` in an unpacked runtime archive: at its root or in bin/, with .exe on Windows builds. */
function program(dir: string, name: string, windows: boolean): string | undefined {
  const file = windows ? `${name}.exe` : name;
  return [join(dir, file), join(dir, 'bin', file)].find((p) => existsSync(p));
}

const run = (
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  verbatim = false,
) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    env,
    maxBuffer: MAX_OUTPUT,
    windowsVerbatimArguments: verbatim,
  });
  return { code: r.status ?? 1, out: spawnOutput(r), error: r.error };
};

/** How a passed or failed check is marked. */
const passMark = (ok: boolean): string => (ok ? '✓' : '✗');

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `ffmpeg -version` names exactly this version (9.1.0, not 9.1.0.1 or 9.1.01). */
export const versionMatches = (out: string, version: string): boolean =>
  new RegExp(`^ffmpeg version ${escape(version)}(?: |$)`, 'm').test(out);

/** The licence flags `ffmpeg -buildconf` lacks: every one the build's licence passes to configure. */
export const missingLicenseFlags = (
  buildconf: string,
  license: keyof typeof LICENSE_FLAGS,
): string[] => {
  const words = new Set(buildconf.split(/\s+/));
  return LICENSE_FLAGS[license].filter((f) => !words.has(f));
};

export interface TestOptions {
  target: string;
  dist: string;
  /** a build this machine can't run fails instead of being skipped: CI, on the runner meant to run it */
  mustRun?: boolean;
  // for tests: what this machine runs, whether Docker works and starts armhf containers, extra environment
  runnable?: string[];
  docker?: boolean;
  armhf?: boolean;
  env?: NodeJS.ProcessEnv;
  /** build.yml's test-env secret, taken out of the environment already (takeTestEnv) */
  testEnv?: ReadonlyMap<string, string>;
  /** where a workflow command (a mask) goes: stdout, ahead of anything a test prints */
  print?: (line: string) => void;
}

export async function runTest(
  folder: Folder,
  data: EngineData,
  options: TestOptions,
): Promise<Result> {
  const t = folder.targets.find((x) => x.name === options.target);
  if (!t) {
    throw new FolderError(
      `no target ${options.target} in ${FOLDER_FILE} (targets: ${folder.targets.map((x) => x.name).join(', ')})`,
    );
  }
  const lock = readFolderLock(join(folder.dir, LOCK_FILE));
  const version = lock?.ffmpeg[t.ffmpeg];
  if (!version) {
    throw new FolderError(
      `${LOCK_FILE} has no FFmpeg ${t.ffmpeg}; run ffmpeg-build lock (and build) first`,
    );
  }
  const runnable = options.runnable ?? runnablePlatforms();
  const host = (options.runnable ? hostOf(runnable) : undefined) ?? process.platform;
  const env = { ...process.env, ...options.env };
  const print =
    options.print ??
    ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  const skip = (why: string): Result =>
    options.mustRun
      ? { output: `${t.name}: ✗ not run, ${why}, and --must-run says it must`, exitCode: 1 }
      : { output: `${t.name}: skipped, ${why}`, exitCode: 0 };

  const library = LIBRARY_PLATFORM.test(t.platform);
  let container: Container | undefined;
  if (library) {
    const why = cannotLink(t.platform, host, env);
    if (why) {
      return skip(`${why} (${DOCTOR_HINT})`);
    }
  } else if (!runnable.includes(t.platform)) {
    const c = containerFor(t.platform, runnable);
    const cant = `${t.platform} builds don't run on this machine (it runs ${runnable.join(', ') || 'none of the build platforms'})`;
    if (!c) {
      return skip(cant);
    }
    if (!(options.docker ?? dockerWorks())) {
      return skip(
        `${cant} (with Docker it would run in ${c.bash === 'apk' ? 'an Alpine' : 'a Debian armhf'} container)`,
      );
    }
    if (
      c.dockerPlatform === 'linux/arm/v7' &&
      !(options.armhf ?? dockerRuns(baseImage(c.image), c.dockerPlatform))
    ) {
      return skip(
        `this machine's Docker can't start a linux/arm/v7 container for it; register qemu for 32-bit ARM: docker run --privileged --rm ${BINFMT} --install arm (${DOCTOR_HINT})`,
      );
    }
    container = c;
  }
  const archive = join(resolve(options.dist), `${artifactName(t, version)}.tar.gz`);
  if (!existsSync(archive)) {
    throw new FolderError(
      `${t.name} isn't built in ${options.dist} (ffmpeg-build build --target ${t.name} --out ${options.dist})`,
    );
  }

  // what the target's patch sets add, by the names the build lists them under
  const patchNames = profileAdditions(targetProfile(folder, t)).names;
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-test-'));
  const lines: string[] = [];
  let failed = 0;
  const step = (ok: boolean | 'info', what: string, detail?: string) => {
    lines.push(`  ${ok === 'info' ? '-' : passMark(ok)} ${what}`);
    if (ok === false) {
      failed++;
      if (detail) {
        lines.push(
          ...detail
            .trim()
            .split('\n')
            .slice(-DETAIL_TAIL_LINES)
            .map((l) => `      ${l}`),
        );
      }
    }
  };
  try {
    await extractTarGzFile(archive, dir);
    if (library) {
      // the -dev archive's headers, when it was built beside it (an Apple build's frameworks carry them too)
      const devArchive = join(resolve(options.dist), `${artifactName(t, version)}-dev.tar.gz`);
      const dev = existsSync(devArchive) ? join(dir, '.dev') : undefined;
      if (dev) {
        await extractTarGzFile(devArchive, dev);
      }
      const arch =
        runnable.includes('osx-arm64') || runnable.includes('linux-arm64') ? 'arm64' : 'x64';
      const slash = (p: string) => p.replaceAll('\\', '/');
      const steps = testLibrary({
        platform: t.platform,
        license: t.license,
        version,
        dir: slash(dir),
        ...(dev ? { dev: slash(dev) } : {}),
        env,
        mustRun: options.mustRun === true,
        host,
        arch,
        rosetta: arch === 'arm64' && runnable.includes('osx-x64'),
        data,
        ...(t.androidApi !== undefined ? { androidApi: t.androidApi } : {}),
        names: patchNames,
      });
      for (const s of steps) {
        step(s.ok, s.what, s.detail);
      }
      for (const test of t.tests) {
        step(
          'info',
          `tests: ${test} not run: ${t.platform} builds have no programs to run it with`,
        );
      }
    } else {
      testPrograms(t, version);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    output: [
      `${t.name} (${artifactName(t, version)}.tar.gz)`,
      ...lines,
      '',
      failed ? `${failed} failed` : 'all passed',
    ].join('\n'),
    exitCode: failed ? 1 : 0,
  };

  function testPrograms(target: Target, ffmpegVersion: string): void {
    const windows = target.platform.startsWith('win-');
    const ffmpeg = program(dir, 'ffmpeg', windows);
    const ffprobe = program(dir, 'ffprobe', windows);
    const testEnv = {
      FFMPEG: ffmpeg ?? '',
      FFPROBE: ffprobe ?? '',
      FFMPEG_DIR: dir,
      FFMPEG_TARGET: target.name,
      FFMPEG_PLATFORM: target.platform,
    };
    const image = container ? baseImage(container.image) : '';
    // the test-env: variables only the target's own scripts get (test-env.ts); the smoke test's commands none
    const secret = options.testEnv ?? new Map<string, string>();
    const given = targetTestEnv(target.testEnv, secret, env, print);
    const docker = (
      cwd: string,
      vars: Record<string, string>,
      cmd: string,
      args: string[],
      network = false,
      pass: Record<string, string> = {},
    ): ReturnType<typeof run> =>
      run(
        'docker',
        dockerArgs(
          image,
          [dir, folder.dir],
          cwd,
          vars,
          cmd,
          args,
          network,
          container!.dockerPlatform,
          Object.keys(pass),
        ),
        { ...env, ...pass },
      );
    // the smoke test's ffmpeg finds its libraries only where the archive put them (a container has nothing else)
    const ffmpegRun = (args: string[]): ReturnType<typeof run> =>
      container ? docker(folder.dir, {}, ffmpeg!, args) : run(ffmpeg!, args, archiveEnv(env, host));
    // Alpine has sh, not bash: add bash for a .sh script (the container's network is needed for that one step)
    const inContainer = (c: Container, script: string, test: string): ReturnType<typeof run> => {
      if (!test.endsWith('.sh')) {
        return docker(folder.dir, testEnv, script, [], false, given.vars);
      }
      return c.bash === 'apk'
        ? docker(
            dirname(script),
            testEnv,
            'sh',
            ['-c', 'apk add --no-cache -q bash >/dev/null && exec bash "$0"', script],
            true,
            given.vars,
          )
        : docker(dirname(script), testEnv, 'bash', [script], false, given.vars);
    };
    const native = (cmd: string, args: string[], verbatim = false): ReturnType<typeof run> =>
      run(cmd, args, { ...scriptEnv(env, secret, given.vars, host), ...testEnv }, verbatim);
    if (container) {
      lines.push(
        `  (in ${String(image.split('@')[0])} ${container.dockerPlatform}, a plain ${container.bash === 'apk' ? 'musl' : 'Debian armhf'} system)`,
      );
    }
    if (!ffmpeg) {
      step(false, `no ffmpeg program in ${artifactName(target, ffmpegVersion)}.tar.gz`);
    } else {
      const v = ffmpegRun(['-hide_banner', '-version']);
      step(
        v.code === 0 && versionMatches(v.out, ffmpegVersion),
        `ffmpeg -version says ${ffmpegVersion}`,
        v.error?.message ?? v.out,
      );
      const conf = ffmpegRun(['-hide_banner', '-buildconf']);
      const missing = missingLicenseFlags(conf.out, target.license);
      step(
        conf.code === 0 && !missing.length,
        `ffmpeg -buildconf matches ${target.license}${missing.length ? ` (missing ${missing.join(' ')})` : ''}`,
        conf.out,
      );
      const enc = ffmpegRun([
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=duration=1:size=320x240:rate=25',
        '-f',
        'null',
        '-',
      ]);
      step(enc.code === 0, 'a one-second test pattern encodes', enc.out);
      // what its configure line asked for is in it (ffmpeg/<major>.yml's ships:)
      const listings = new Map<ShippedKind, Set<string> | undefined>();
      const has: Has = (kind, name) => {
        if (kind === 'resamplers') {
          // a resampler is in no listing: swresample refuses to start one it was built without
          return (
            ffmpegRun([
              '-hide_banner',
              '-loglevel',
              'error',
              '-f',
              'lavfi',
              '-i',
              'sine=duration=0.1',
              '-af',
              `aresample=22050:resampler=${name}`,
              '-f',
              'null',
              '-',
            ]).code === 0
          );
        }
        if (!listings.has(kind)) {
          const r = ffmpegRun(['-hide_banner', `-${kind}`]);
          listings.set(kind, r.code === 0 ? listedNames(kind, r.out) : undefined);
          if (r.code !== 0) {
            step(false, `ffmpeg -${kind} lists them`, r.error?.message ?? r.out);
          }
        }
        // a format with several names (mov,mp4,m4a): listed under each
        return listings.get(kind)?.has(listedAs(name)) ?? `ffmpeg -${kind} failed`;
      };
      const major = ffmpegVersion.split('.')[0]!;
      for (const s of shippedSteps(
        expectedComponents(data, major, target.platform, conf.out, patchNames),
        has,
      )) {
        step(s.ok, s.what, s.detail);
      }
      // the target's own tests, from the folder
      if (target.tests.length && given.missing.length) {
        step(
          'info',
          `test-env: ${given.missing.join(', ')} not set, so the tests run without ${given.missing.length > 1 ? 'them' : 'it'} (a run without the secret, like a pull request from a fork's, has none)`,
        );
      }
      for (const test of target.tests) {
        const script = join(folder.dir, test);
        const how = container ? undefined : scriptCommand(script);
        if (how && 'error' in how) {
          step(false, `tests: ${test}`, how.error);
        } else {
          const r = how
            ? native(how.cmd, how.args, how.verbatim)
            : inContainer(container!, script, test);
          step(r.code === 0, `tests: ${test}`, r.error?.message ?? r.out);
        }
      }
    }
  }
}
