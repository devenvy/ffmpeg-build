import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createToolchain } from '../src/build/toolchain.ts';
import { packageRoot } from '../src/paths.ts';

const captured = readFileSync(
  join(packageRoot, 'tests', 'fixtures', 'toolchains', 'legacy-captured.txt'),
  'utf8',
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const envNames = [
  'ANDROID_ABI',
  'ANDROID_NDK_HOME',
  'ANDROID_TRIPLE',
  'API',
  'AR',
  'CC',
  'CROSS_HOST',
  'CROSS_PREFIX',
  'CXX',
  'CXXFLAGS',
  'CXX_RT_LIB',
  'CFLAGS',
  'LDFLAGS',
  'NM',
  'PKG_CONFIG_LIBDIR',
  'RANLIB',
  'STRIP',
  'TOOLCHAIN',
];
const normalize = (text: string, root: string) =>
  text
    .replaceAll(root.replaceAll('\\', '/'), '{ROOT}')
    .replace(/^([A-Za-z]):/gm, (_, drive: string) => `/${drive.toLowerCase()}`)
    .replaceAll('\r\n', '\n');
const array = (name: string, values: string[]) =>
  values.length
    ? `declare -a ${name}=(${values.map((value, i) => `[${i}]="${value}"`).join(' ')})`
    : `declare -a ${name}=()`;
function legacySection(rid: string): string {
  return captured
    .split(`=== ${rid}\n`)[1]!
    .split(/(?=^=== )/m)[0]!
    .trimEnd()
    .replaceAll(`{ROOT}/.work/legacy/${rid}`, '{ROOT}');
}

function actual(setup: string, rid: string, ndk = ''): string {
  const root = mkdtempSync(join(tmpdir(), `ffb-${rid}-`));
  roots.push(root);
  const deps = join(root, 'deps');
  const tc = createToolchain({
    setup,
    platform: rid,
    depsDir: deps,
    work: '/work',
    engine: join(packageRoot, 'platforms'),
    env: { PATH: '/usr/bin:/bin', ANDROID_NDK_HOME: ndk },
  });
  const lines = envNames.flatMap((name) =>
    tc.env[name] !== undefined ? [`${name}=${tc.env[name]}`] : [],
  );
  lines.push(array('CMAKE_CROSS_ARGS', tc.cmakeArgs), array('MESON_CROSS_ARGS', tc.mesonArgs));
  // the toolchain files each setup generates
  const generatedFiles: Record<string, string[]> = {
    'linux-armhf': ['armhf-meson.ini', 'armhf.cmake'],
    windows: ['windows-meson.ini', 'windows.cmake'],
    android: ['android-meson.ini'],
  };
  const generated = (generatedFiles[setup] ?? []).map((label): [string, string] => [
    label,
    join(root, 'toolchain', label),
  ]);
  for (const [label, path] of generated) {
    if (existsSync(path)) {
      lines.push(`--- toolchain/${label}`, readFileSync(path, 'utf8').trimEnd());
    }
  }
  return normalize(lines.join('\n'), root);
}

describe('platform toolchains reproduce the captured setup scripts', () => {
  it.each([
    ['linux-x64', 'linux', ''],
    ['linux-musl-x64', 'linux-musl', ''],
    ['linux-armhf', 'linux-armhf', ''],
    ['win-x64', 'windows', ''],
    ['win-arm64', 'windows', ''],
    ['android-arm64', 'android', '/opt/android-ndk'],
    ['android-x64', 'android', '/opt/android-ndk'],
  ] as const)('%s', (rid, setup, ndk) => {
    expect(actual(setup, rid, ndk)).toBe(legacySection(rid));
  });
});

const appleCommand = (_command: string, args: string[]) => {
  const sdk = args[1] ?? 'macosx';
  const query = args.at(-1)!;
  if (query === '--show-sdk-path') {
    return `/Xcode/SDKs/${sdk}.sdk`;
  }
  if (query.startsWith('--find ')) {
    return `/Xcode/usr/bin/${query.slice(7)}`;
  }
  if (['clang', 'clang++', 'ar', 'ranlib'].includes(query)) {
    return `/Xcode/usr/bin/${query}`;
  }
  throw new Error(`unexpected xcrun ${args.join(' ')}`);
};
function apple(platform: string, setup: 'apple-macos' | 'apple-ios') {
  const root = mkdtempSync(join(tmpdir(), `ffb-${platform}-`));
  roots.push(root);
  const deps = `${root.replaceAll('\\', '/')}/deps`;
  return {
    deps,
    tc: createToolchain({
      platform,
      setup,
      depsDir: deps,
      work: '/Users/build/work',
      engine: packageRoot,
      env: { PATH: '/usr/bin:/bin', HOME: '/Users/build' },
      command: appleCommand,
    }),
  };
}

describe('Apple toolchains derived from the legacy scripts', () => {
  it('osx-arm64', () => {
    const { tc } = apple('osx-arm64', 'apple-macos');
    expect(tc.env).toMatchObject({
      CC: '/Xcode/usr/bin/clang',
      CXX: '/Xcode/usr/bin/clang++',
      SDKROOT: '/Xcode/SDKs/macosx.sdk',
      MACOSX_DEPLOYMENT_TARGET: '11.0',
      CFLAGS: expect.stringMatching(/^-mmacosx-version-min=11\.0 -ffile-prefix-map=/),
      LDFLAGS: '-mmacosx-version-min=11.0',
    });
    expect(tc.cmakeArgs).toEqual([
      '-DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew;/usr/local;/opt/local',
      '-DCMAKE_FIND_FRAMEWORK=LAST',
      '-DCMAKE_OSX_ARCHITECTURES=arm64',
    ]);
    expect(tc.mesonArgs).toEqual([]);
  });
  it('osx-x64', () => {
    const { deps, tc } = apple('osx-x64', 'apple-macos');
    expect(tc.env).toMatchObject({
      CROSS_HOST: 'x86_64-apple-darwin',
      CFLAGS: expect.stringMatching(/^-arch x86_64 -mmacosx-version-min=11\.0/),
      LDFLAGS: '-arch x86_64 -mmacosx-version-min=11.0',
    });
    expect(readFileSync(`${deps}.toolchain/toolchain.cmake`, 'utf8')).toContain(
      'set(CMAKE_ASM_FLAGS_INIT "-arch x86_64")\nset(CMAKE_C_COMPILER /Xcode/usr/bin/clang)\n',
    );
    expect(readFileSync(`${deps}.toolchain/meson-cross.ini`, 'utf8')).toContain(
      'needs_exe_wrapper = true\n',
    );
  });
  it.each([
    ['ios-arm64', 'iphoneos', '-miphoneos-version-min=13.0', 'iPhoneOS'],
    ['ios-sim-arm64', 'iphonesimulator', '-mios-simulator-version-min=13.0', 'iPhoneSimulator'],
  ] as const)('%s', (platform, sdk, min, fw) => {
    const { deps, tc } = apple(platform, 'apple-ios');
    expect(tc.env).toMatchObject({
      APPLE_SDK: sdk,
      CROSS_HOST: 'aarch64-apple-darwin',
      IOS_MINVER: min,
      FW_PLATFORM: fw,
      FW_MIN_OS: '13.0',
    });
    expect(tc.env['CFLAGS']).toBe(
      `-arch arm64 ${min} -isysroot /Xcode/SDKs/${sdk}.sdk -ffile-prefix-map=/Users/build/work=/work -ffile-prefix-map=${deps}=/opt/ffmpeg-build/deps`,
    );
    expect(readFileSync(`${deps}.toolchain/toolchain.cmake`, 'utf8')).toContain(
      'set(CMAKE_OSX_DEPLOYMENT_TARGET 13.0)\n',
    );
    expect(readFileSync(`${deps}.toolchain/meson-cross.ini`, 'utf8')).toContain(
      `'${min}', '-I${deps}/include'`,
    );
  });
  it.each([
    ['maccatalyst-arm64', 'arm64', 'aarch64'],
    ['maccatalyst-x64', 'x86_64', 'x86_64'],
  ] as const)('%s', (platform, arch, family) => {
    const { deps, tc } = apple(platform, 'apple-ios');
    const target = `${arch}-apple-ios14.0-macabi`;
    expect(tc.env).toMatchObject({
      MCAT_ARCH: arch,
      MCAT_FFARCH: family,
      MCAT_TARGET: target,
      CROSS_HOST: `${family}-apple-darwin`,
      FW_PLATFORM: 'MacOSX',
      FW_MIN_OS: '14.0',
    });
    expect(tc.env['CFLAGS']).toContain(
      `-target ${target} -isysroot /Xcode/SDKs/macosx.sdk -iframework /Xcode/SDKs/macosx.sdk/System/iOSSupport/System/Library/Frameworks`,
    );
    expect(readFileSync(`${deps}.toolchain/toolchain.cmake`, 'utf8')).toContain(
      `set(CMAKE_SHARED_LINKER_FLAGS_INIT "-target ${target}")\n`,
    );
    expect(readFileSync(`${deps}.toolchain/meson-cross.ini`, 'utf8')).toContain(
      `cpu_family = '${family}'\n`,
    );
  });
});
