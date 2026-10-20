// How `ffmpeg-build test` tests a build that ships libraries and no programs (Android, iOS, Mac Catalyst): it links
// platforms/test/smoke.c against the build with the platform's own toolchain (the Android NDK, Xcode's SDKs), which
// proves the libraries have every symbol a consumer needs, then runs it where the platform can run: on an Android
// device or emulator (adb), in the iOS simulator, or on this Mac (Mac Catalyst). The program prints the version and
// configure line, which are checked as `ffmpeg -version` and `-buildconf` are, encodes and decodes a frame with a codec
// the build has, and lists what the build registered, as `ffmpeg -encoders` and the rest do. What the build must have
// follows from that configure line (shipped.ts): the defaults its components: didn't leave out, what its options ship,
// and what it asked for by name, so a slim build is asked only for what it was built with. A build no machine here can
// run has the names of those components looked for in its libraries instead.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';

import { androidApiFor } from '../android-api.ts';
import { packageRoot } from '../paths.ts';
import {
  expectedComponents,
  libraryDefaults,
  NO_ROUND_TRIP,
  roundTripCodec,
  shippedSteps,
  smokeProbes,
  smokeReport,
  staticConfigure,
  staticHas,
  staticLibrary,
} from './shipped.ts';
import {
  archiveEnv,
  MAX_OUTPUT,
  missingLicenseFlags,
  spawnOutput,
  versionMatches,
} from './test.ts';

import type { LICENSE_FLAGS } from '../build/plan.ts';
import type { EngineData } from '../engine-data.ts';
import type { RuntimeNames } from '../ffmpeg-components.ts';

/** Where on a device the Android smoke program and the libraries go. */
const ANDROID_DIR = '/data/local/tmp/ffmpeg-build-test';
const ANDROID: Record<string, { triple: string; abi: string }> = {
  'android-arm64': { triple: 'aarch64-linux-android', abi: 'arm64-v8a' },
  'android-x64': { triple: 'x86_64-linux-android', abi: 'x86_64' },
};
/** FFmpeg's libraries, each before the ones it needs, as a static link order would want them. */
const LIBS = ['avformat', 'avfilter', 'avcodec', 'swscale', 'swresample', 'avutil'];
/** How long a command may run by default (ten minutes: a link, a simulator boot). */
const COMMAND_TIMEOUT_MS = 600_000;
/** How long an adb command may run (five minutes). */
const ADB_TIMEOUT_MS = 300_000;
/** The SDK an Apple library platform's smoke program links against. */
const APPLE_SDK: Partial<Record<string, string>> = {
  'ios-arm64': 'iphoneos',
  'ios-sim-arm64': 'iphonesimulator',
};

interface Command {
  cmd: string;
  args: string[];
}
export interface Step {
  ok: boolean | 'info';
  what: string;
  detail?: string;
}

const smokeSource = (engineRoot = packageRoot): string =>
  posix.join(engineRoot.replaceAll('\\', '/'), 'platforms', 'test', 'smoke.c');

/**
 * The NDK clang that links the smoke program against an Android build's lib/<abi>, for the API level the build was
 * made for: a library that calls what that level's C library lacks fails the link (lld refuses a shared library's
 * undefined symbols in a program).
 */
export function androidSmoke(
  platform: string,
  ndk: string,
  hostDir: string,
  run: string,
  out: string,
  source: string,
  api: number,
): Command {
  const { triple, abi } = ANDROID[platform]!;
  return {
    cmd: posix.join(ndk, 'toolchains', 'llvm', 'prebuilt', hostDir, 'bin', `${triple}${api}-clang`),
    args: [
      source,
      '-I',
      posix.join(run, 'include'),
      '-L',
      posix.join(run, 'lib', abi),
      ...LIBS.map((l) => `-l${l}`),
      `-Wl,-rpath,${ANDROID_DIR}`,
      '-o',
      out,
    ],
  };
}

/** xcrun clang with the platform SDK, linking the smoke program against the frameworks at the toolchain minimums. */
export function appleSmoke(
  platform: string,
  sdk: string,
  run: string,
  include: string | undefined,
  out: string,
  source: string,
): Command {
  const target: Record<string, string[]> = {
    'ios-arm64': [
      '--sdk',
      'iphoneos',
      'clang',
      '-arch',
      'arm64',
      '-miphoneos-version-min=13.0',
      '-isysroot',
      sdk,
    ],
    'ios-sim-arm64': [
      '--sdk',
      'iphonesimulator',
      'clang',
      '-arch',
      'arm64',
      '-mios-simulator-version-min=13.0',
      '-isysroot',
      sdk,
    ],
  };
  // Catalyst: the macOS SDK with an ios*-macabi target, and the iOS frameworks it keeps under System/iOSSupport
  const catalyst = (arch: string) => [
    '--sdk',
    'macosx',
    'clang',
    '-target',
    `${arch}-apple-ios14.0-macabi`,
    '-isysroot',
    sdk,
    '-iframework',
    `${sdk}/System/iOSSupport/System/Library/Frameworks`,
    '-L',
    `${sdk}/System/iOSSupport/usr/lib`,
  ];
  const head = target[platform] ?? catalyst(platform === 'maccatalyst-x64' ? 'x86_64' : 'arm64');
  return {
    cmd: 'xcrun',
    args: [
      ...head,
      source,
      ...(include ? ['-I', include] : []),
      '-F',
      run,
      ...LIBS.flatMap((l) => ['-framework', `lib${l}`]),
      `-Wl,-rpath,${run}`,
      '-o',
      out,
    ],
  };
}

export type RunWhere =
  | { where: 'here' | 'rosetta' | 'simulator' | 'device' }
  | { where: 'never' | 'nowhere'; why: string };

/** Where a library build's smoke program runs from this machine: `never` for a platform no machine runs it on. */
export function libraryRun(
  platform: string,
  host: NodeJS.Platform,
  arch: string,
  rosetta: boolean,
): RunWhere {
  if (platform.startsWith('android-')) {
    return { where: 'device' };
  }
  if (platform === 'ios-arm64') {
    return { where: 'never', why: 'iOS device builds run only on an iOS device' };
  }
  if (host !== 'darwin') {
    return { where: 'nowhere', why: `${platform} builds run only on a Mac` };
  }
  if (platform === 'ios-sim-arm64') {
    return arch === 'arm64'
      ? { where: 'simulator' }
      : { where: 'nowhere', why: 'the arm64 iOS simulator runs only on Apple silicon' };
  }
  if (platform === 'maccatalyst-arm64') {
    return arch === 'arm64'
      ? { where: 'here' }
      : { where: 'nowhere', why: 'an arm64 Mac Catalyst build runs only on Apple silicon' };
  }
  if (arch === 'x64') {
    return { where: 'here' };
  }
  return rosetta
    ? { where: 'rosetta' }
    : {
        where: 'nowhere',
        why: "an x86_64 Mac Catalyst build runs on Apple silicon only under Rosetta, which isn't installed (softwareupdate --install-rosetta --agree-to-license)",
      };
}

interface Runtimes {
  runtimes: {
    name: string;
    identifier: string;
    isAvailable?: boolean;
    supportedDeviceTypes?: { name: string; identifier: string }[];
  }[];
}

/** The newest available iOS runtime, and an iPhone it supports (a device type and runtime chosen apart may not pair). */
export function pickSimulator(list: Runtimes): { runtime: string; deviceType: string } | undefined {
  const ios = list.runtimes.filter(
    (r) => r.name.startsWith('iOS') && r.isAvailable !== false && r.supportedDeviceTypes?.length,
  );
  const r = ios.at(-1);
  if (!r) {
    return undefined;
  }
  const phones = r.supportedDeviceTypes!.filter((d) => d.name.includes('iPhone'));
  return {
    runtime: r.identifier,
    deviceType: (phones.at(-1) ?? r.supportedDeviceTypes!.at(-1)!).identifier,
  };
}

/** The checks the smoke program's exit code and output pass or fail. */
export function smokeResult(
  code: number,
  out: string,
  version: string,
  license: keyof typeof LICENSE_FLAGS,
): Step[] {
  const conf = /^configuration: (.*)$/m.exec(out)?.[1];
  const missing = conf === undefined ? [] : missingLicenseFlags(conf, license);
  const failure = /^smoke: FAIL (.*)$/m.exec(out)?.[1];
  const step = (ok: boolean, what: string): Step => (ok ? { ok, what } : { ok, what, detail: out });
  return [
    step(versionMatches(out, version), `it says FFmpeg ${version}`),
    step(
      conf !== undefined && !missing.length,
      `its configure line matches ${license}${missing.length ? ` (missing ${missing.join(' ')})` : ''}`,
    ),
    step(
      code === 0 && /^smoke: ok$/m.test(out),
      `its libraries load and answer${failure ? ` (${failure})` : ''}`,
    ),
  ];
}

/**
 * Everything a run of the smoke program says about the build: smokeResult's checks, then, from the configure line it
 * printed, what the build must have done and have: the round trip with the codec it has (roundTripCodec), the
 * defaults its components: didn't leave out, and what its options and components: asked for. A slim build is asked
 * only for what it was built with.
 */
export function smokeSteps(o: {
  code: number;
  out: string;
  version: string;
  license: keyof typeof LICENSE_FLAGS;
  data: EngineData;
  platform: string;
  names?: RuntimeNames;
}): Step[] {
  const steps = smokeResult(o.code, o.out, o.version, o.license);
  const configure = /^configuration: (.*)$/m.exec(o.out)?.[1];
  if (o.code !== 0 || configure === undefined) {
    return steps;
  }
  const major = o.version.split('.')[0]!;
  const codec = roundTripCodec(configure);
  const made = /^smoke: a (\S+) frame encodes and decodes$/m.exec(o.out)?.[1];
  if (codec === undefined) {
    steps.push({ ok: 'info', what: `no frame round trip: ${NO_ROUND_TRIP}` });
  } else if (made === codec) {
    steps.push({ ok: true, what: `a ${codec} frame encodes and decodes` });
  } else {
    steps.push({
      ok: false,
      what: `a ${codec} frame encodes and decodes (${made ? `it made the round trip with ${made}` : 'it made no round trip'}: its configure line has the ${codec} encoder and decoder)`,
      detail: o.out,
    });
  }
  const has = smokeReport(o.out);
  return [
    ...steps,
    ...shippedSteps(libraryDefaults(o.data, major, configure), has),
    ...shippedSteps(expectedComponents(o.data, major, o.platform, configure, o.names), has),
  ];
}

const run = (
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeout = COMMAND_TIMEOUT_MS,
): { code: number; out: string; error: Error | undefined } => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', env, timeout, maxBuffer: MAX_OUTPUT });
  return { code: r.status ?? 1, out: spawnOutput(r), error: r.error };
};
const found = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;

/** The Android NDK this machine has, from the variables the NDK and GitHub's runners set. */
export const androidNdk = (
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): string | undefined =>
  [
    env['ANDROID_NDK_HOME'],
    env['ANDROID_NDK_LATEST_HOME'],
    env['ANDROID_NDK_ROOT'],
    env['ANDROID_NDK'],
  ].find((d) => d && exists(posix.join(d.replaceAll('\\', '/'), 'toolchains', 'llvm', 'prebuilt')));

/** A library of an unpacked library build: lib/<abi>/lib<name>.so on Android, the framework's binary on Apple. */
function libraryFile(platform: string, dir: string, base: string): string {
  return platform.startsWith('android-')
    ? posix.join(dir, 'lib', ANDROID[platform]!.abi, `lib${base}.so`)
    : posix.join(dir, `lib${base}.framework`, `lib${base}`);
}

/**
 * For a build that didn't run: what it must ship, looked for by name in its libraries (shipped.ts's staticHas). Weaker
 * than running (a name compiled in, not its registration), but an iOS device build runs nowhere else.
 */
export function staticShipped(
  platform: string,
  dir: string,
  data: EngineData,
  major: string,
  names: RuntimeNames = {},
): Step[] {
  const bytes = new Map<string, Buffer | undefined>();
  const read = (base: string): Buffer | undefined => {
    if (!bytes.has(base)) {
      const file = libraryFile(platform, dir, base);
      bytes.set(base, existsSync(file) ? readFileSync(file) : undefined);
    }
    return bytes.get(base);
  };
  const avutil = read('avutil');
  const configure = avutil && staticConfigure(avutil);
  if (configure === undefined) {
    return [
      {
        ok: false,
        what: `what it must ship not checked: no configure line in ${avutil ? 'its' : 'a'} libavutil`,
      },
    ];
  }
  return [
    { ok: 'info', what: 'what it must ship: looked for by name in its libraries instead' },
    ...shippedSteps(
      [
        ...libraryDefaults(data, major, configure),
        ...expectedComponents(data, major, platform, configure, names),
      ],
      (kind, name) => {
        const base = staticLibrary(kind);
        if (!base) {
          return 'only running the build can tell';
        }
        const lib = read(base);
        if (!lib) {
          return `it has no lib${base}`;
        }
        const inLib = staticHas(lib, name);
        return inLib === 'suffix'
          ? `lib${base} has it only as the end of a longer name, which looks the same`
          : inLib;
      },
    ),
  ];
}

/** Why this machine can't even link against a library build, or nothing when it can. */
export function cannotLink(
  platform: string,
  host: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (platform.startsWith('android-')) {
    if (host === 'win32') {
      return `linking a program against an ${platform} build needs Linux or macOS with the Android NDK`;
    }
    return androidNdk(env)
      ? undefined
      : `linking a program against an ${platform} build needs the Android NDK (set ANDROID_NDK_HOME)`;
  }
  if (host !== 'darwin') {
    return `linking a program against a ${platform} build needs a Mac with Xcode`;
  }
  return found('xcrun', ['--find', 'clang'])
    ? undefined
    : `linking a program against a ${platform} build needs Xcode (xcode-select -s /Applications/Xcode.app/Contents/Developer)`;
}

/**
 * Links the smoke program against the unpacked build and runs it where it can. `dir` is the runtime archive, `dev`
 * the -dev archive (its headers) when it is there. Steps it couldn't take are reported with ok 'info' (`-`); under
 * mustRun, not running a build that can run somewhere is a failure.
 */
export function testLibrary(o: {
  platform: string;
  license: keyof typeof LICENSE_FLAGS;
  version: string;
  dir: string;
  dev?: string;
  env: NodeJS.ProcessEnv;
  mustRun: boolean;
  host?: NodeJS.Platform;
  arch?: string;
  rosetta: boolean;
  /** the engine's data, for what each option the build has on must ship */
  data: EngineData;
  /** android: the target's android-api: (default 28), the level the smoke program is linked for */
  androidApi?: number;
  /** the names the build lists its patch sets' components by, where they aren't configure's (about.yml's listed-as) */
  names?: RuntimeNames;
}): Step[] {
  const host = o.host ?? process.platform;
  const arch = o.arch ?? process.arch;
  const major = o.version.split('.')[0]!;
  const steps: Step[] = [];
  const work = mkdtempSync(posix.join(tmpdir().replaceAll('\\', '/'), 'ffmpeg-build-smoke-'));
  const out = posix.join(work, 'smoke');
  try {
    let link: Command;
    if (o.platform.startsWith('android-')) {
      const ndk = androidNdk(o.env)!.replaceAll('\\', '/');
      const prebuilt = posix.join(ndk, 'toolchains', 'llvm', 'prebuilt');
      link = androidSmoke(
        o.platform,
        ndk,
        readdirSync(prebuilt)[0] ?? '',
        o.dir,
        out,
        smokeSource(),
        androidApiFor(o.androidApi),
      );
    } else {
      const sdkName = APPLE_SDK[o.platform] ?? 'macosx';
      const sdk = run('xcrun', ['--sdk', sdkName, '--show-sdk-path']).out.trim();
      const include =
        o.dev && existsSync(posix.join(o.dev, 'include'))
          ? posix.join(o.dev, 'include')
          : undefined;
      link = appleSmoke(o.platform, sdk, o.dir, include, out, smokeSource());
    }
    const linked = run(link.cmd, link.args);
    steps.push({
      ok: linked.code === 0,
      what: `a program links against it (${o.platform.startsWith('android-') ? 'the NDK' : "Xcode's SDK"})`,
      detail: linked.error?.message ?? linked.out,
    });
    if (linked.code !== 0) {
      return steps;
    }

    const where = libraryRun(o.platform, host, arch, o.rosetta);
    const notRun = (why: string, canRunElsewhere: boolean) => {
      steps.push({
        ok: o.mustRun && canRunElsewhere ? false : 'info',
        what: `not run: ${why}${o.mustRun && canRunElsewhere ? ' (--must-run)' : ''}`,
      });
      steps.push(...staticShipped(o.platform, o.dir, o.data, major, o.names));
      return steps;
    };
    if (where.where === 'never') {
      return notRun(where.why, false);
    }
    if (where.where === 'nowhere') {
      return notRun(where.why, true);
    }
    // every component any option names: which of them the build must have, its configure line says
    const probes = smokeProbes(o.data, major);
    let ran: { code: number; out: string; error?: Error } | { notRun: string };
    // nothing in the environment may lead the loader to frameworks or libraries outside the build (as for the archive's
    // own ffmpeg): an incomplete build fails here, as it would in an app
    if (where.where === 'here') {
      ran = run(out, probes, archiveEnv(process.env));
    } else if (where.where === 'rosetta') {
      ran = run('arch', ['-x86_64', out, ...probes], archiveEnv(process.env));
    } else if (where.where === 'simulator') {
      ran = inSimulator(out, probes);
    } else {
      ran = onAndroid(o.platform, o.dir, out, o.env, probes);
    }
    if ('notRun' in ran) {
      return notRun(ran.notRun, true);
    }
    const how = {
      here: 'on this Mac',
      rosetta: 'on this Mac, under Rosetta',
      simulator: 'in the iOS simulator',
      device: 'on the Android device',
    }[where.where];
    steps.push({ ok: 'info', what: `ran the program ${how}` });
    steps.push(
      ...smokeSteps({
        code: ran.code,
        out: ran.error ? `${ran.error.message}\n${ran.out}` : ran.out,
        version: o.version,
        license: o.license,
        data: o.data,
        platform: o.platform,
        names: o.names,
      }),
    );
    return steps;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Runs the smoke program in a booted iOS simulator, booting (and afterwards deleting) one when none is. */
function inSimulator(
  program: string,
  args: string[],
): { code: number; out: string; error?: Error } | { notRun: string } {
  const booted = run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
  if (booted.code !== 0) {
    return { notRun: `xcrun simctl doesn't answer: ${booted.out.trim()}` };
  }
  const devices = Object.entries(
    (JSON.parse(booted.out) as { devices: Record<string, { udid: string; state: string }[]> })
      .devices,
  )
    .filter(([runtime]) => runtime.includes('iOS'))
    .flatMap(([, list]) => list)
    .filter((d) => d.state === 'Booted');
  let udid = devices[0]?.udid;
  let made = false;
  if (!udid) {
    const runtimes = run('xcrun', ['simctl', 'list', 'runtimes', '-j']);
    const pick =
      runtimes.code === 0 ? pickSimulator(JSON.parse(runtimes.out) as Runtimes) : undefined;
    if (!pick) {
      return { notRun: 'no iOS simulator runtime is installed (xcodebuild -downloadPlatform iOS)' };
    }
    const created = run('xcrun', [
      'simctl',
      'create',
      'ffmpeg-build-test',
      pick.deviceType,
      pick.runtime,
    ]);
    if (created.code !== 0) {
      return { code: 1, out: `couldn't create a simulator: ${created.out}` };
    }
    udid = created.out.trim();
    made = true;
    const boot = run('xcrun', ['simctl', 'boot', udid]);
    const ready = boot.code === 0 ? run('xcrun', ['simctl', 'bootstatus', udid, '-b']) : boot;
    if (ready.code !== 0) {
      run('xcrun', ['simctl', 'delete', udid]);
      return { code: 1, out: `the simulator didn't boot: ${ready.out}` };
    }
  }
  try {
    return run('xcrun', ['simctl', 'spawn', udid, program, ...args]);
  } finally {
    if (made) {
      run('xcrun', ['simctl', 'shutdown', udid]);
      run('xcrun', ['simctl', 'delete', udid]);
    }
  }
}

/**
 * Runs the smoke program on the Android device adb sees (an emulator in CI). The libraries go beside it, each given
 * that folder as its run path (copies; the build isn't changed): an arm64 program on an x86_64 emulator runs through
 * its native bridge, whose linker reads only run paths, and a run path isn't inherited by the libraries it loads.
 */
function onAndroid(
  platform: string,
  dir: string,
  program: string,
  env: NodeJS.ProcessEnv,
  probes: string[],
): { code: number; out: string; error?: Error } | { notRun: string } {
  const adb = (...args: string[]): ReturnType<typeof run> => run('adb', args, env, ADB_TIMEOUT_MS);
  const devices = adb('devices');
  if (devices.error) {
    return { notRun: 'adb is not installed' };
  }
  if (!/\tdevice$/m.test(devices.out)) {
    return { notRun: 'adb sees no Android device or emulator' };
  }
  const { abi } = ANDROID[platform]!;
  const abis = adb('shell', 'getprop', 'ro.product.cpu.abilist').out.trim();
  if (!abis.split(',').includes(abi)) {
    return { notRun: `the device runs ${abis || 'an unknown ABI'}, not ${abi}` };
  }
  if (!found('patchelf', ['--version'])) {
    return {
      code: 1,
      out: 'needs patchelf, to give the libraries pushed to the device their run path (apt-get install patchelf)',
    };
  }
  const libdir = posix.join(dir, 'lib', abi);
  const copies = mkdtempSync(posix.join(tmpdir().replaceAll('\\', '/'), 'ffmpeg-build-android-'));
  try {
    adb('shell', `rm -rf ${ANDROID_DIR} && mkdir -p ${ANDROID_DIR}`);
    for (const so of readdirSync(libdir).filter((f) => f.endsWith('.so'))) {
      const copy = posix.join(copies, so);
      copyFileSync(posix.join(libdir, so), copy);
      const patched = run('patchelf', ['--set-rpath', ANDROID_DIR, copy]);
      if (patched.code !== 0) {
        return { code: 1, out: `patchelf --set-rpath failed on ${so}: ${patched.out}` };
      }
      const pushed = adb('push', copy, `${ANDROID_DIR}/${so}`);
      if (pushed.code !== 0) {
        return { code: 1, out: `adb push ${so} failed: ${pushed.out}` };
      }
    }
    const pushed = adb('push', program, `${ANDROID_DIR}/smoke`);
    if (pushed.code !== 0) {
      return { code: 1, out: `adb push failed: ${pushed.out}` };
    }
    // adb's own exit code is the shell's only on newer devices: the program's comes back in the output. The arguments
    // are kinds and component names, which the engine data's schema keeps to [a-z0-9_-]: nothing for the shell
    const r = adb(
      'shell',
      `cd ${ANDROID_DIR} && chmod 755 smoke && LD_LIBRARY_PATH=${ANDROID_DIR} ./smoke ${probes.join(' ')}; echo "exit=$?"`,
    );
    const code = Number(/^exit=(\d+)\s*$/m.exec(r.out)?.[1] ?? 1);
    return { code, out: r.out.replace(/^exit=\d+\s*$/m, '').trim() };
  } finally {
    adb('shell', `rm -rf ${ANDROID_DIR}`);
    rmSync(copies, { recursive: true, force: true });
  }
}
