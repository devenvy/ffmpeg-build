import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Toolchain {
  env: NodeJS.ProcessEnv;
  cmakeArgs: string[];
  mesonArgs: string[];
}

/**
 * The C++ runtime a static link against a C++ library needs (recipes' `{cxx-runtime}`, for the Libs.private of their
 * .pc files): libc++ with Apple's clang and the Android NDK, the static archive where the platform links the runtime
 * statically (musl, llvm-mingw on win-arm64), libstdc++ elsewhere.
 */
export function cxxRuntime(platform: string): string {
  if (/^(?:osx|ios|maccatalyst|android)-/.test(platform)) {
    return '-lc++';
  }
  if (platform === 'win-arm64') {
    return '-l:libc++.a';
  }
  if (platform.startsWith('linux-musl-')) {
    return '-l:libstdc++.a';
  }
  return '-lstdc++';
}

/** The toolchains platforms.yml's `setup:` can name. */
export const SETUPS = [
  'linux',
  'linux-musl',
  'linux-armhf',
  'android',
  'windows',
  'apple-macos',
  'apple-ios',
] as const;

export interface ToolchainOptions {
  platform: string;
  setup: string;
  depsDir: string;
  work: string;
  engine: string;
  env?: NodeJS.ProcessEnv;
  command?: (command: string, args: string[]) => string;
  /** --in here: build with this machine's own compilers (Linux, MSYS2), not the image's or a cross toolchain */
  native?: boolean;
  /** android: the API level to compile for (the plan's: the target's android-api:, default 28) */
  androidApi?: number;
}

/** The Android API level a plan made before android-api: (with none) builds for. */
const ANDROID_API_BEFORE = 28;

const lines = (...value: string[]) => `${value.join('\n')}\n`;
const posixDirname = (path: string) => path.replace(/[\\/][^\\/]+$/, '');

function writeChanged(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    if (readFileSync(path, 'utf8') === content) {
      return;
    }
  } catch {
    /* new file */
  }
  writeFileSync(path, content);
}

function crossFile(
  deps: string,
  values: {
    c: string;
    cpp: string;
    ar: string;
    strip: string;
    system: string;
    cpuFamily: string;
    cpu: string;
    windres?: string;
    wrapper?: boolean;
    extra?: string[];
  },
): string {
  return lines(
    '[binaries]',
    `c = '${values.c}'`,
    `cpp = '${values.cpp}'`,
    `ar = '${values.ar}'`,
    `strip = '${values.strip}'`,
    ...(values.windres ? [`windres = '${values.windres}'`] : []),
    "pkg-config = 'pkg-config'",
    '[host_machine]',
    `system = '${values.system}'`,
    `cpu_family = '${values.cpuFamily}'`,
    `cpu = '${values.cpu}'`,
    "endian = 'little'",
    '[properties]',
    `pkg_config_libdir = '${deps}/lib/pkgconfig'`,
    `needs_exe_wrapper = ${values.wrapper === false ? 'false' : 'true'}`,
    ...(values.extra ?? []),
  );
}

function searchArgs(deps: string): string[] {
  return [
    '[built-in options]',
    `c_args = ['-I${deps}/include']`,
    `cpp_args = ['-I${deps}/include']`,
    `c_link_args = ['-L${deps}/lib']`,
    `cpp_link_args = ['-L${deps}/lib']`,
  ];
}

function applePath(env: NodeJS.ProcessEnv): { brew: string; path: string } {
  const brew = env['HOMEBREW_PREFIX'] ?? '/opt/homebrew';
  const tools = ['grep', 'coreutils', 'gnu-tar', 'findutils', 'gnu-sed'].map(
    (tool) => `${brew}/opt/${tool}/libexec/gnubin`,
  );
  return { brew, path: [`${brew}/bin`, ...tools, env['PATH'] ?? ''].join(':') };
}

/**
 * winpthreads' licence in an MSYS2 environment: its package installs it under <prefix>/share/licenses/ (the folder's
 * name has varied: winpthreads, libwinpthread). The prefix is MSYS2's /mingw64 and the like, so cygpath gives the
 * Windows path Node reads.
 */
export function msys2WinpthreadsNotice(
  env: NodeJS.ProcessEnv,
  run: (command: string, args: string[]) => string,
): string {
  const prefix = env['MINGW_PREFIX'] ?? env['MSYSTEM_PREFIX'];
  if (!prefix) {
    throw new Error('MINGW_PREFIX is not set: run the native Windows build from an MSYS2 shell');
  }
  const licenses = `${run('cygpath', ['-m', prefix])}/share/licenses`;
  const found = existsSync(licenses)
    ? readdirSync(licenses)
        .filter((d) => /winpthread/i.test(d))
        .sort()
        .flatMap((d) =>
          readdirSync(`${licenses}/${d}`)
            .filter((f) => /^(COPYING|LICENSE)/i.test(f))
            .sort()
            .map((f) => `${licenses}/${d}/${f}`),
        )
    : [];
  if (!found.length) {
    throw new Error(
      `no winpthreads licence under ${licenses} (its package installs one; is the MSYS2 environment's toolchain installed?)`,
    );
  }
  return found[0]!;
}

/** Materialize the platform environment and the exact CMake/Meson files formerly written by setup/*.sh. */
export function createToolchain(options: ToolchainOptions): Toolchain {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  const deps = options.depsDir.replaceAll('\\', '/');
  const work = options.work.replaceAll('\\', '/');
  const run =
    options.command ??
    ((command, args) => execFileSync(command, args, { encoding: 'utf8', env }).trim());
  let cmakeArgs: string[] = [];
  let mesonArgs: string[] = [];

  if (options.native && options.setup === 'linux') {
    // a glibc Linux machine building its own platform: its compilers, with the image's flags
    env['CFLAGS'] = '-fPIC';
    env['CXXFLAGS'] = '-fPIC';
  } else if (options.native && options.setup === 'windows') {
    // MSYS2's MinGW environment: its compilers by their plain names; cmake on Ninja (its default on Windows is Visual Studio)
    const arm = options.platform === 'win-arm64';
    if (!arm && options.platform !== 'win-x64') {
      throw new Error(`windows does not build ${options.platform}`);
    }
    const clang = arm || (env['MSYSTEM'] ?? '').startsWith('CLANG'); // MSYS2's CLANG64/CLANGARM64 ship clang, MINGW64/UCRT64 gcc
    Object.assign(env, {
      CC: clang ? 'clang' : 'gcc',
      CXX: clang ? 'clang++' : 'g++',
      AR: 'ar',
      RANLIB: 'ranlib',
      NM: 'nm',
      STRIP: 'strip',
      DLLTOOL_MACHINE: arm ? 'arm64' : 'i386:x86-64',
      ...(arm ? { CXX_RT_LIB: '-l:libc++.a' } : {}),
    });
    delete env['CROSS_HOST'];
    delete env['CROSS_PREFIX'];
    env['WINPTHREADS_NOTICE'] = msys2WinpthreadsNotice(env, run);
    cmakeArgs = ['-G', 'Ninja'];
  } else if (options.native && options.setup !== 'apple-macos' && options.setup !== 'apple-ios') {
    throw new Error(
      `${options.platform} has no native toolchain (--in here is for linux-x64, linux-arm64, win-* and Apple)`,
    );
  } else if (options.setup === 'linux' || options.setup === 'linux-musl') {
    env['CFLAGS'] = '-fPIC';
    env['CXXFLAGS'] = '-fPIC';
    if (options.setup === 'linux') {
      const root = '/opt/rh/gcc-toolset-14/root/usr';
      env['PATH'] = `${root}/bin${env['PATH'] ? `:${env['PATH']}` : ''}`;
      env['MANPATH'] = `${root}/share/man:${env['MANPATH'] ?? ''}`;
      env['INFOPATH'] = `${root}/share/info${env['INFOPATH'] ? `:${env['INFOPATH']}` : ''}`;
      env['LD_LIBRARY_PATH'] =
        `${root}/lib64${env['LD_LIBRARY_PATH'] ? `:${env['LD_LIBRARY_PATH']}` : ''}`;
      env['PCP_DIR'] = '/opt/rh/gcc-toolset-14/root';
    }
  } else if (options.setup === 'linux-armhf') {
    env['CROSS_HOST'] = 'arm-linux-gnueabihf';
    env['CROSS_PREFIX'] = 'arm-linux-gnueabihf';
    env['CFLAGS'] = '-fPIC';
    env['CXXFLAGS'] = '-fPIC';
    const dir = `${posixDirname(deps)}/toolchain`;
    const cmake = `${dir}/armhf.cmake`;
    const meson = `${dir}/armhf-meson.ini`;
    writeChanged(
      cmake,
      lines(
        'set(CMAKE_SYSTEM_NAME Linux)',
        'set(CMAKE_SYSTEM_PROCESSOR arm)',
        'set(CMAKE_C_COMPILER arm-linux-gnueabihf-gcc)',
        'set(CMAKE_CXX_COMPILER arm-linux-gnueabihf-g++)',
        'set(CMAKE_C_FLAGS_INIT "-mfpu=neon")',
        'set(CMAKE_CXX_FLAGS_INIT "-mfpu=neon")',
        `set(CMAKE_FIND_ROOT_PATH ${deps})`,
        'set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)',
        'set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)',
        'set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)',
      ),
    );
    writeChanged(
      meson,
      crossFile(deps, {
        c: 'arm-linux-gnueabihf-gcc',
        cpp: 'arm-linux-gnueabihf-g++',
        ar: 'arm-linux-gnueabihf-ar',
        strip: 'arm-linux-gnueabihf-strip',
        system: 'linux',
        cpuFamily: 'arm',
        cpu: 'armv7',
        extra: searchArgs(deps),
      }),
    );
    cmakeArgs = [`-DCMAKE_TOOLCHAIN_FILE=${cmake}`];
    mesonArgs = ['--cross-file', meson];
  } else if (options.setup === 'android') {
    const ndk = env['ANDROID_NDK_HOME'];
    if (!ndk) {
      throw new Error('the Android NDK (ANDROID_NDK_HOME) is not set');
    }
    const arm = options.platform === 'android-arm64';
    if (!arm && options.platform !== 'android-x64') {
      throw new Error(`android does not build ${options.platform}`);
    }
    const triple = arm ? 'aarch64-linux-android' : 'x86_64-linux-android';
    const abi = arm ? 'arm64-v8a' : 'x86_64';
    const cpu = arm ? 'aarch64' : 'x86_64';
    const toolchain = `${ndk}/toolchains/llvm/prebuilt/linux-x86_64`;
    // the NDK's per-level compiler drivers target that level's headers and libraries (aarch64-linux-android24-clang)
    const api = String(options.androidApi ?? ANDROID_API_BEFORE);
    Object.assign(env, {
      API: api,
      TOOLCHAIN: toolchain,
      ANDROID_TRIPLE: triple,
      ANDROID_ABI: abi,
      CROSS_HOST: triple,
      CC: `${toolchain}/bin/${triple}${api}-clang`,
      CXX: `${toolchain}/bin/${triple}${api}-clang++`,
      AR: `${toolchain}/bin/llvm-ar`,
      RANLIB: `${toolchain}/bin/llvm-ranlib`,
      STRIP: `${toolchain}/bin/llvm-strip`,
      NM: `${toolchain}/bin/llvm-nm`,
      LDFLAGS: '-Wl,-z,max-page-size=16384',
    });
    const dir = `${posixDirname(deps)}/toolchain`;
    const meson = `${dir}/android-meson.ini`;
    writeChanged(
      meson,
      crossFile(deps, {
        c: env['CC']!,
        cpp: env['CXX']!,
        ar: env['AR']!,
        strip: env['STRIP']!,
        system: 'android',
        cpuFamily: cpu,
        cpu,
        extra: searchArgs(deps),
      }),
    );
    cmakeArgs = [
      `-DCMAKE_TOOLCHAIN_FILE=${ndk}/build/cmake/android.toolchain.cmake`,
      `-DANDROID_ABI=${abi}`,
      `-DANDROID_PLATFORM=android-${api}`,
    ];
    mesonArgs = ['--cross-file', meson];
  } else if (options.setup === 'windows') {
    const arm = options.platform === 'win-arm64';
    if (!arm && options.platform !== 'win-x64') {
      throw new Error(`windows does not build ${options.platform}`);
    }
    const prefix = arm ? 'aarch64-w64-mingw32' : 'x86_64-w64-mingw32';
    const cc = arm ? `${prefix}-clang` : `${prefix}-gcc-win32`;
    const cxx = arm ? `${prefix}-clang++` : `${prefix}-g++-win32`;
    Object.assign(env, {
      CROSS_PREFIX: prefix,
      CROSS_HOST: prefix,
      CC: cc,
      CXX: cxx,
      AR: `${prefix}-ar`,
      RANLIB: `${prefix}-ranlib`,
      NM: `${prefix}-nm`,
      STRIP: `${prefix}-strip`,
      ...(arm ? { CXX_RT_LIB: '-l:libc++.a' } : {}),
    });
    const dir = `${posixDirname(deps)}/toolchain`;
    const cmake = `${dir}/windows.cmake`;
    const meson = `${dir}/windows-meson.ini`;
    writeChanged(
      cmake,
      lines(
        'set(CMAKE_SYSTEM_NAME Windows)',
        `set(CMAKE_SYSTEM_PROCESSOR ${arm ? 'ARM64' : 'x86_64'})`,
        `set(CMAKE_C_COMPILER ${arm ? cc : `${prefix}-gcc`})`,
        `set(CMAKE_CXX_COMPILER ${arm ? cxx : `${prefix}-g++`})`,
        `set(CMAKE_RC_COMPILER ${prefix}-windres)`,
        `set(CMAKE_FIND_ROOT_PATH ${deps})`,
        'set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)',
        'set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)',
        'set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)',
      ),
    );
    writeChanged(
      meson,
      crossFile(deps, {
        c: cc,
        cpp: cxx,
        ar: `${prefix}-ar`,
        strip: `${prefix}-strip`,
        windres: `${prefix}-windres`,
        system: 'windows',
        cpuFamily: arm ? 'aarch64' : 'x86_64',
        cpu: arm ? 'aarch64' : 'x86_64',
        extra: searchArgs(deps),
      }),
    );
    env['DLLTOOL_MACHINE'] = arm ? 'arm64' : 'i386:x86-64';
    cmakeArgs = [`-DCMAKE_TOOLCHAIN_FILE=${cmake}`];
    mesonArgs = ['--cross-file', meson];
    env['WINPTHREADS_NOTICE'] = arm
      ? '/opt/llvm-mingw/aarch64-w64-mingw32/share/mingw32/COPYING.winpthreads.txt'
      : '/usr/share/doc/mingw-w64-x86-64-dev/copyright';
  } else if (options.setup === 'apple-macos' || options.setup === 'apple-ios') {
    const apple = applePath(env);
    env['PATH'] = apple.path;
    const prefixMap = `-ffile-prefix-map=${work}=/work -ffile-prefix-map=${deps}=/opt/ffmpeg-build/deps`;
    const xcrun = (sdk: string, ...what: string[]) => run('xcrun', ['--sdk', sdk, ...what]);
    if (options.setup === 'apple-macos') {
      env['CC'] = run('xcrun', ['--find', 'clang']);
      env['CXX'] = run('xcrun', ['--find', 'clang++']);
      env['SDKROOT'] = xcrun('macosx', '--show-sdk-path');
      env['MACOSX_DEPLOYMENT_TARGET'] = '11.0';
      const arch = options.platform === 'osx-x64' ? '-arch x86_64 ' : '';
      env['CFLAGS'] = `${arch}-mmacosx-version-min=11.0 ${prefixMap}`;
      env['CXXFLAGS'] = env['CFLAGS'];
      env['LDFLAGS'] = `${arch}-mmacosx-version-min=11.0`;
      env['AR'] = run('xcrun', ['--find', 'ar']);
      env['RANLIB'] = run('xcrun', ['--find', 'ranlib']);
      Object.assign(env, {
        EXTRA_CFLAGS: env['CFLAGS'],
        EXTRA_CXXFLAGS: env['CXXFLAGS'],
        EXTRA_LDFLAGS: env['LDFLAGS'],
        PKG_CONFIG_LIBDIR: `${deps}/lib/pkgconfig`,
      });
      cmakeArgs = [
        `-DCMAKE_IGNORE_PREFIX_PATH=${apple.brew};/usr/local;/opt/local`,
        '-DCMAKE_FIND_FRAMEWORK=LAST',
      ];
      if (options.platform === 'osx-arm64') {
        cmakeArgs.push('-DCMAKE_OSX_ARCHITECTURES=arm64');
      } else if (options.platform === 'osx-x64') {
        env['CROSS_HOST'] = 'x86_64-apple-darwin';
        const dir = `${deps}.toolchain`;
        const cmake = `${dir}/toolchain.cmake`;
        const meson = `${dir}/meson-cross.ini`;
        writeChanged(
          cmake,
          lines(
            'set(CMAKE_SYSTEM_NAME Darwin)',
            'set(CMAKE_SYSTEM_PROCESSOR x86_64)',
            `set(CMAKE_OSX_SYSROOT ${env['SDKROOT']})`,
            'set(CMAKE_OSX_ARCHITECTURES x86_64)',
            'set(CMAKE_OSX_DEPLOYMENT_TARGET 11.0)',
            "# the architecture on every compiler CMake drives: ggml's Metal backend embeds its shader library through generated",
            '# assembly, which CMAKE_OSX_ARCHITECTURES alone left arm64 (ranlib: cputype does not match previous archive members)',
            ...['C', 'CXX', 'OBJC', 'OBJCXX', 'ASM'].map(
              (n) => `set(CMAKE_${n}_FLAGS_INIT "-arch x86_64")`,
            ),
            `set(CMAKE_C_COMPILER ${env['CC']})`,
            `set(CMAKE_CXX_COMPILER ${env['CXX']})`,
            `set(CMAKE_FIND_ROOT_PATH ${deps} ${env['SDKROOT']})`,
            'set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)',
            'set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)',
            'set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)',
            'set(CMAKE_FIND_FRAMEWORK LAST)',
          ),
        );
        const args = `['-arch', 'x86_64', '-isysroot', '${env['SDKROOT']}', '-mmacosx-version-min=11.0'`;
        writeChanged(
          meson,
          lines(
            '[binaries]',
            `c = '${env['CC']}'`,
            `cpp = '${env['CXX']}'`,
            `ar = '${env['AR']}'`,
            "strip = 'strip'",
            "pkg-config = 'pkg-config'",
            '[built-in options]',
            `c_args = ${args}, '-I${deps}/include']`,
            `cpp_args = ${args}, '-I${deps}/include']`,
            `c_link_args = ${args}, '-L${deps}/lib']`,
            `cpp_link_args = ${args}, '-L${deps}/lib']`,
            '[host_machine]',
            "system = 'darwin'",
            "cpu_family = 'x86_64'",
            "cpu = 'x86_64'",
            "endian = 'little'",
            '[properties]',
            `pkg_config_libdir = '${deps}/lib/pkgconfig'`,
            'needs_exe_wrapper = true',
          ),
        );
        cmakeArgs = [
          `-DCMAKE_TOOLCHAIN_FILE=${cmake}`,
          `-DCMAKE_IGNORE_PREFIX_PATH=${apple.brew};/usr/local;/opt/local`,
        ];
        mesonArgs = ['--cross-file', meson];
      } else {
        throw new Error(`apple-macos does not build ${options.platform}`);
      }
    } else {
      const ios = options.platform.startsWith('ios-');
      const catalyst = options.platform.startsWith('maccatalyst-');
      if (!ios && !catalyst) {
        throw new Error(`apple-ios does not build ${options.platform}`);
      }
      let sdk = 'iphonesimulator';
      if (catalyst) {
        sdk = 'macosx';
      } else if (options.platform === 'ios-arm64') {
        sdk = 'iphoneos';
      }
      env['CC'] = xcrun(sdk, '--find', 'clang');
      env['CXX'] = xcrun(sdk, '--find', 'clang++');
      env['AR'] = xcrun(sdk, '--find', 'ar');
      env['RANLIB'] = xcrun(sdk, '--find', 'ranlib');
      const sdkPath = xcrun(sdk, '--show-sdk-path');
      env['APPLE_SDK'] = sdk;
      env['SDK_PATH'] = sdkPath;
      const dir = `${deps}.toolchain`;
      const cmake = `${dir}/toolchain.cmake`;
      const meson = `${dir}/meson-cross.ini`;
      if (ios) {
        const min =
          options.platform === 'ios-arm64'
            ? '-miphoneos-version-min=13.0'
            : '-mios-simulator-version-min=13.0';
        Object.assign(env, {
          IOS_SYSROOT: sdkPath,
          IOS_MINVER: min,
          CROSS_HOST: 'aarch64-apple-darwin',
          FW_PLATFORM: options.platform === 'ios-arm64' ? 'iPhoneOS' : 'iPhoneSimulator',
          FW_MIN_OS: '13.0',
        });
        const iosFlags = `-arch arm64 ${min} -isysroot ${sdkPath} ${prefixMap}`;
        env['CFLAGS'] = iosFlags;
        env['CXXFLAGS'] = iosFlags;
        env['LDFLAGS'] = iosFlags;
        writeChanged(
          cmake,
          lines(
            'set(CMAKE_SYSTEM_NAME iOS)',
            'set(CMAKE_SYSTEM_PROCESSOR arm64)',
            `set(CMAKE_OSX_SYSROOT ${sdkPath})`,
            'set(CMAKE_OSX_ARCHITECTURES arm64)',
            'set(CMAKE_OSX_DEPLOYMENT_TARGET 13.0)',
            `set(CMAKE_FIND_ROOT_PATH ${deps})`,
            'set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)',
            'set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)',
            'set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)',
          ),
        );
        const a = `['-arch', 'arm64', '-isysroot', '${sdkPath}', '${min}'`;
        writeChanged(
          meson,
          lines(
            '[binaries]',
            `c = '${env['CC']}'`,
            `cpp = '${env['CXX']}'`,
            `ar = '${env['AR']}'`,
            "strip = 'strip'",
            "pkg-config = 'pkg-config'",
            '[built-in options]',
            `c_args = ${a}, '-I${deps}/include']`,
            `cpp_args = ${a}, '-I${deps}/include']`,
            `c_link_args = ${a}, '-L${deps}/lib']`,
            `cpp_link_args = ${a}, '-L${deps}/lib']`,
            '[host_machine]',
            "system = 'darwin'",
            "cpu_family = 'aarch64'",
            "cpu = 'aarch64'",
            "endian = 'little'",
            '[properties]',
            `pkg_config_libdir = '${deps}/lib/pkgconfig'`,
            'needs_exe_wrapper = true',
          ),
        );
      } else {
        const arch = options.platform.endsWith('x64') ? 'x86_64' : 'arm64';
        const ffarch = arch === 'arm64' ? 'aarch64' : 'x86_64';
        const target = `${arch}-apple-ios14.0-macabi`;
        const support = `${sdkPath}/System/iOSSupport`;
        if (!options.command && !existsSync(`${support}/System/Library/Frameworks`)) {
          throw new Error(`${sdkPath} has no Catalyst (iOSSupport) tree`);
        }
        Object.assign(env, {
          MCAT_ARCH: arch,
          MCAT_FFARCH: ffarch,
          MCAT_TARGET: target,
          MCAT_SYSROOT: sdkPath,
          MCAT_IOSSUPPORT: support,
          CROSS_HOST: `${ffarch}-apple-darwin`,
          CC_FOR_BUILD: `${xcrun('macosx', '--find', 'clang')} -isysroot ${sdkPath}`,
          FW_PLATFORM: 'MacOSX',
          FW_MIN_OS: '14.0',
        });
        env['CFLAGS'] =
          `-target ${target} -isysroot ${sdkPath} -iframework ${support}/System/Library/Frameworks -isystem ${support}/usr/include ${prefixMap}`;
        env['CXXFLAGS'] = env['CFLAGS'];
        env['LDFLAGS'] =
          `-target ${target} -isysroot ${sdkPath} -F${support}/System/Library/Frameworks -L${support}/usr/lib`;
        writeChanged(
          cmake,
          lines(
            'set(CMAKE_SYSTEM_NAME Darwin)',
            `set(CMAKE_SYSTEM_PROCESSOR ${arch})`,
            `set(CMAKE_OSX_SYSROOT ${sdkPath})`,
            `set(CMAKE_OSX_ARCHITECTURES ${arch})`,
            ...['C', 'CXX', 'OBJC', 'OBJCXX', 'ASM'].map(
              (n) => `set(CMAKE_${n}_FLAGS_INIT "-target ${target}")`,
            ),
            `set(CMAKE_EXE_LINKER_FLAGS_INIT "-target ${target}")`,
            `set(CMAKE_SHARED_LINKER_FLAGS_INIT "-target ${target}")`,
            `set(CMAKE_FIND_ROOT_PATH ${deps} ${sdkPath})`,
            'set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)',
            'set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)',
            'set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)',
            'set(CMAKE_FIND_FRAMEWORK LAST)',
          ),
        );
        const a = `['-target', '${target}', '-isysroot', '${sdkPath}'`;
        writeChanged(
          meson,
          lines(
            '[binaries]',
            `c = '${env['CC']}'`,
            `cpp = '${env['CXX']}'`,
            `ar = '${env['AR']}'`,
            "strip = 'strip'",
            "pkg-config = 'pkg-config'",
            '[built-in options]',
            `c_args = ${a}, '-I${deps}/include']`,
            `cpp_args = ${a}, '-I${deps}/include']`,
            `c_link_args = ${a}, '-L${deps}/lib']`,
            `cpp_link_args = ${a}, '-L${deps}/lib']`,
            '[host_machine]',
            "system = 'darwin'",
            `cpu_family = '${ffarch}'`,
            `cpu = '${ffarch}'`,
            "endian = 'little'",
            '[properties]',
            `pkg_config_libdir = '${deps}/lib/pkgconfig'`,
            'needs_exe_wrapper = false',
          ),
        );
      }
      Object.assign(env, {
        EXTRA_CFLAGS: env['CFLAGS'],
        EXTRA_CXXFLAGS: env['CXXFLAGS'],
        EXTRA_LDFLAGS: env['LDFLAGS'],
        PKG_CONFIG_LIBDIR: `${deps}/lib/pkgconfig`,
      });
      cmakeArgs = [`-DCMAKE_TOOLCHAIN_FILE=${cmake}`];
      mesonArgs = ['--cross-file', meson];
    }
  } else if (options.setup !== 'fake') {
    throw new Error(`unknown platform toolchain ${options.setup}`);
  }
  env['PKG_CONFIG_PATH'] = `${deps}/lib/pkgconfig`;
  return { env, cmakeArgs, mesonArgs };
}

export function toolchainFacts(
  engineRoot: string,
  setup: string,
  platform: string,
  depsDir: string,
  env: NodeJS.ProcessEnv,
): string {
  if (!setup.startsWith('apple-')) {
    throw new Error(`${setup} has no host toolchain facts`);
  }
  const tc = createToolchain({
    platform,
    setup,
    depsDir,
    work: env['FFB_WORK'] ?? '/work',
    engine: engineRoot,
    env,
  });
  const command = (name: string, args: string[]) =>
    execFileSync(name, args, { encoding: 'utf8', env: tc.env }).trim();
  const sdk = tc.env['APPLE_SDK'] ?? 'macosx';
  const tools = readFileSync(join(engineRoot, 'platforms', 'apple-brew.txt'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'));
  return `${command('xcodebuild', ['-version']).replaceAll('\n', ' ')}\n${sdk} ${command('xcrun', ['--sdk', sdk, '--show-sdk-version'])}\n${command('brew', ['list', '--versions', ...tools])}\n`;
}

function rewritePcFiles(depsDir: string, edit: (text: string) => string): void {
  const dir = join(depsDir, 'lib', 'pkgconfig');
  if (!existsSync(dir)) {
    return;
  }
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.pc'))) {
    const path = join(dir, name);
    const before = readFileSync(path, 'utf8');
    const after = edit(before);
    if (after !== before) {
      writeFileSync(path, after);
    }
  }
}

const removeLibrary = (input: string, name: RegExp, replacement = ''): string => {
  let text = input;
  let old = '';
  while (old !== text) {
    old = text;
    text = text.replace(new RegExp(`(^|\\s)${name.source}(?=\\s|$)`, 'gm'), `$1${replacement}`);
  }
  return text;
};

/** Platform hook immediately before FFmpeg configure, including its generated host flags. */
export function beforeFfmpeg(
  context: {
    buildPlan: { platform: string; setup: string };
    depsDir: string;
    env: NodeJS.ProcessEnv;
  },
  ffmpegDir: string,
  flags: readonly string[],
): string[] {
  const { setup, platform } = context.buildPlan;
  // a toolchain setting as configure gets it (an unset one reads `undefined`, as it always has)
  const setting = (name: string): string => String(context.env[name]);
  if (setup === 'linux-musl') {
    rewritePcFiles(context.depsDir, (text) =>
      removeLibrary(removeLibrary(text, /-lgcc_s/), /-lstdc\+\+/, '-l:libstdc++.a'),
    );
  }
  if (setup === 'windows') {
    rewritePcFiles(context.depsDir, (input) => {
      const text = removeLibrary(input, /-lgcc_s/);
      if (platform === 'win-arm64') {
        return removeLibrary(
          removeLibrary(
            removeLibrary(text, /-l(?:std)?c\+\+/, '-l:libc++.a'),
            /-lunwind/,
            '-l:libunwind.a',
          ),
          /-l(?:win)?pthread/,
          '-l:libwinpthread.a',
        );
      }
      if (text.includes('-Wl,-Bstatic')) {
        return text;
      }
      return text
        .replaceAll('-lpthread', '-Wl,-Bstatic -lpthread -Wl,-Bdynamic')
        .replaceAll('-lstdc++', '-Wl,-Bstatic -lstdc++ -Wl,-Bdynamic');
    });
  }
  // a native Windows build (MSYS2) compiles for the machine it runs on: no cross compiler, prefix or toolchain names
  const nativeWindows = setup === 'windows' && context.env['FFB_IN'] === 'here';
  const out = nativeWindows
    ? flags.filter(
        (f) =>
          f !== '--enable-cross-compile' &&
          !/^--(?:cross-prefix|cc|cxx|ar|ranlib|nm|strip|windres)=.*-w64-mingw32/.test(f),
      )
    : [...flags];
  // MSYS2's compilers use the posix thread model: link their runtimes (winpthreads, libgcc) into the DLLs statically, as
  // the image's -win32 compilers need no runtime DLL; the archives ship none
  if (nativeWindows) {
    out.push('--extra-ldflags=-static');
  }
  if (setup === 'android') {
    out.push(
      `--cc=${setting('CC')}`,
      `--cxx=${setting('CXX')}`,
      `--ar=${setting('AR')}`,
      `--ranlib=${setting('RANLIB')}`,
      `--strip=${setting('STRIP')}`,
      `--nm=${setting('NM')}`,
      `--sysroot=${setting('TOOLCHAIN')}/sysroot`,
    );
  }
  if (setup === 'apple-ios') {
    out.push(
      `--cc=${setting('CC')}`,
      `--cxx=${setting('CXX')}`,
      `--ar=${setting('AR')}`,
      `--ranlib=${setting('RANLIB')}`,
      `--sysroot=${setting('SDK_PATH')}`,
      `--extra-cflags=${setting('CFLAGS')}`,
      `--extra-cxxflags=${setting('CXXFLAGS')}`,
      `--extra-ldflags=${setting('LDFLAGS')}`,
    );
    if (platform.startsWith('maccatalyst-')) {
      const path = join(ffmpegDir, 'libavcodec', 'videotoolbox.c');
      let text = readFileSync(path, 'utf8');
      if (!text.includes('TARGET_OS_MACCATALYST')) {
        text = text.replace(
          /^#if TARGET_OS_IPHONE$/m,
          '#if TARGET_OS_MACCATALYST\n    /* Mac Catalyst: no OpenGL(ES) interop (patched by ffmpeg-build). */\n#elif TARGET_OS_IPHONE',
        );
        if (!text.includes('#if TARGET_OS_MACCATALYST')) {
          throw new Error('videotoolbox.c Mac Catalyst patch did not apply');
        }
        writeFileSync(path, text);
      }
    }
  }
  return out;
}
