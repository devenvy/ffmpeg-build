import {
  copyFileSync,
  cpSync,
  existsSync,
  globSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { shipsSymbols, symbolsName } from '../targets.ts';
import { keptPath } from './cache.ts';
import { keptFiles, type SourceRecord } from './fetch.ts';
import { checkNotices, writeNotices } from './notices.ts';
import { run, searchOutput, step } from './run.ts';

import type { BuildContext } from './library.ts';

/** How far the sources record is indented. */
const JSON_INDENT = 2;
/**
 * What a Mach-O file loads, from `otool -L`: each indented line's path, once. The unindented lines are headers naming
 * the file itself, one per architecture in a universal file (`<path> (architecture arm64):`), not loads.
 */
export function otoolLoads(output: string): string[] {
  const loads = output
    .split(/\r?\n/)
    .filter((line) => /^\s/.test(line) && line.trim())
    .map((line) => line.trim().split(/\s/)[0]!);
  return [...new Set(loads)];
}

/** The ELF segment alignment Android's 16 KB page devices need. */
const ANDROID_PAGE_ALIGN = 0x4000;

// cp -a: a symlink is copied as it is (fs.cp would make a relative one absolute, pointing out of the archive)
export function copyContents(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    cpSync(join(from, name), join(to, name), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
}

function files(pattern: string): string[] {
  return globSync(pattern.replaceAll('\\', '/')).sort();
}

export function copyMatches(pattern: string, to: string, required = true): string[] {
  const found = files(pattern);
  if (required && found.length === 0) {
    throw new Error(`nothing matches ${pattern}`);
  }
  mkdirSync(to, { recursive: true });
  for (const file of found) {
    cpSync(file, join(to, basename(file)), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
  return found.map((file) => join(to, basename(file)));
}

/** Where a staged .pc file's libraries are, relative to its prefix: Android keeps them per ABI, Windows in lib/. */
function pcLibdir(platform: string): string {
  if (platform.startsWith('android-')) {
    return `\${prefix}/lib/${platform === 'android-arm64' ? 'arm64-v8a' : 'x86_64'}`;
  }
  return platform.startsWith('win-') ? `\${prefix}/lib` : `\${prefix}`;
}

function stagePc(install: string, dev: string, platform: string, depsDir: string): void {
  const to = join(dev, 'lib', 'pkgconfig');
  mkdirSync(to, { recursive: true });
  for (const pc of files(join(install, 'lib', 'pkgconfig', '*.pc'))) {
    const libdir = pcLibdir(platform);
    let text = readFileSync(pc, 'utf8')
      .replace(/^prefix=.*$/m, `prefix=\${pcfiledir}/../..`)
      .replace(/^exec_prefix=.*$/m, `exec_prefix=\${prefix}`)
      .replace(/^libdir=.*$/m, `libdir=${libdir}`)
      .replace(/^includedir=.*$/m, `includedir=\${prefix}/include`);
    if (/^(osx|ios|maccatalyst)-/.test(platform)) {
      text = text.replaceAll(depsDir, '/opt/ffmpeg-build/deps');
    }
    writeFileSync(join(to, basename(pc)), text);
  }
}

async function stagePlatform(
  context: BuildContext,
  install: string,
  runDir: string,
  devDir: string,
): Promise<void> {
  const platform = context.buildPlan.platform;
  mkdirSync(join(devDir, 'include'), { recursive: true });
  mkdirSync(join(devDir, 'lib', 'pkgconfig'), { recursive: true });
  if (context.buildPlan.setup === 'fake') {
    if (existsSync(join(install, 'lib'))) {
      copyContents(join(install, 'lib'), runDir);
    }
    if (existsSync(join(install, 'include'))) {
      copyContents(join(install, 'include'), join(devDir, 'include'));
    }
    return;
  }
  if (platform.startsWith('linux-')) {
    copyMatches(join(install, 'lib', '*.so*'), runDir);
    copyMatches(join(install, 'bin', 'ffmpeg'), runDir);
    copyMatches(join(install, 'bin', 'ffprobe'), runDir);
    for (const glob of context.buildPlan.runtime) {
      copyMatches(join(context.depsDir, glob), runDir);
    }
    for (const file of [
      join(runDir, 'ffmpeg'),
      join(runDir, 'ffprobe'),
      ...files(join(runDir, '*.so*')),
    ]) {
      if (!lstatSync(file).isSymbolicLink()) {
        await run('patchelf', ['--set-rpath', '$ORIGIN', file], { env: context.env });
      }
    }
    copyContents(join(install, 'include'), join(devDir, 'include'));
    stagePc(install, devDir, platform, context.depsDir);
    return;
  }
  if (platform.startsWith('win-')) {
    copyMatches(join(install, 'bin', '*.dll'), runDir);
    copyMatches(join(install, 'bin', 'ffmpeg.exe'), runDir);
    copyMatches(join(install, 'bin', 'ffprobe.exe'), runDir);
    copyContents(join(install, 'include'), join(devDir, 'include'));
    stagePc(install, devDir, platform, context.depsDir);
    mkdirSync(join(devDir, 'lib'), { recursive: true });
    for (const dll of files(join(runDir, '*.dll'))) {
      const stem = basename(dll, '.dll');
      const def = join(context.work, `${stem}.def`);
      const body = await run('gendef', ['-', dll], { env: context.env, capture: true });
      writeFileSync(def, body);
      await run(
        'llvm-dlltool',
        [
          '-m',
          context.env['DLLTOOL_MACHINE']!,
          '-d',
          def,
          '-D',
          basename(dll),
          '-l',
          join(devDir, 'lib', `${stem.replace(/-[^-]+$/, '')}.lib`),
        ],
        { env: context.env },
      );
    }
    return;
  }
  if (platform.startsWith('android-')) {
    const abi = context.env['ANDROID_ABI']!;
    const libdir = join(runDir, 'lib', abi);
    mkdirSync(join(runDir, 'include'), { recursive: true });
    mkdirSync(libdir, { recursive: true });
    copyContents(join(install, 'include'), join(runDir, 'include'));
    copyContents(join(install, 'include'), join(devDir, 'include'));
    for (const so of files(join(install, 'lib', '*.so'))) {
      copyFileSync(realpathSync(so), join(libdir, basename(so)));
    }
    for (const glob of context.buildPlan.runtime) {
      copyMatches(join(context.depsDir, glob), libdir);
    }
    for (const so of files(join(libdir, '*.so'))) {
      await run('patchelf', ['--set-soname', basename(so), so], { env: context.env });
    }
    for (const so of files(join(libdir, '*.so'))) {
      for (const dep of files(join(libdir, '*.so'))) {
        const base = basename(dep);
        const needed = (
          await run('patchelf', ['--print-needed', so], { env: context.env, capture: true })
        )
          .split(/\r?\n/)
          .filter((n) => n.startsWith(`${base}.`) && /^\d/.test(n.slice(base.length + 1)));
        for (const name of needed) {
          await run('patchelf', ['--replace-needed', name, base, so], { env: context.env });
        }
      }
    }
    copyFileSync(
      join(
        context.env['TOOLCHAIN']!,
        'sysroot',
        'usr',
        'lib',
        context.env['ANDROID_TRIPLE']!,
        'libc++_shared.so',
      ),
      join(libdir, 'libc++_shared.so'),
    );
    stagePc(install, devDir, platform, context.depsDir);
    return;
  }
  if (platform.startsWith('osx-')) {
    copyMatches(join(install, 'lib', '*.dylib'), runDir);
    copyMatches(join(install, 'bin', 'ffmpeg'), runDir);
    copyMatches(join(install, 'bin', 'ffprobe'), runDir);
    for (const glob of context.buildPlan.runtime) {
      copyMatches(join(context.depsDir, glob), runDir);
    }
    for (const lib of files(join(runDir, '*.dylib'))) {
      if (!lstatSync(lib).isSymbolicLink()) {
        const name = basename(lib);
        const major = name.replace(/^(lib[a-zA-Z0-9_-]+)\.([0-9]+)(\..*)?\.dylib$/, '$1.$2.dylib');
        await run('install_name_tool', ['-id', `@rpath/${major}`, lib], { env: context.env });
      }
    }
    for (const target of [
      join(runDir, 'ffmpeg'),
      join(runDir, 'ffprobe'),
      ...files(join(runDir, '*.dylib')),
    ]) {
      if (!lstatSync(target).isSymbolicLink()) {
        const refs = otoolLoads(
          await run('otool', ['-L', target], { env: context.env, capture: true }),
        ).filter((ref) =>
          [install, context.depsDir, context.work].some((dir) => ref.startsWith(`${dir}/`)),
        );
        for (const ref of refs) {
          await run('install_name_tool', ['-change', ref, `@rpath/${basename(ref)}`, target], {
            env: context.env,
          });
        }
        const load = await run('otool', ['-l', target], { env: context.env, capture: true });
        if (!load.includes('path @loader_path ')) {
          await run('install_name_tool', ['-add_rpath', '@loader_path', target], {
            env: context.env,
          });
        }
        await run('codesign', ['--force', '--sign', '-', target], { env: context.env });
      }
    }
    copyContents(join(install, 'include'), join(devDir, 'include'));
    stagePc(install, devDir, platform, context.depsDir);
    return;
  }
  const version = context.buildPlan.ffmpeg!.version;
  const dylibOf = (base: string): string => join(install, 'lib', `lib${base}.dylib`);
  const bases = ['avcodec', 'avformat', 'avutil', 'avfilter', 'swscale', 'swresample'].filter(
    (base) => existsSync(dylibOf(base)),
  );
  for (const base of bases) {
    const dylib = dylibOf(base);
    const fw = `lib${base}`;
    const fwdir = join(runDir, `${fw}.framework`);
    mkdirSync(join(fwdir, 'Headers'), { recursive: true });
    copyFileSync(realpathSync(dylib), join(fwdir, fw));
    copyContents(join(install, 'include', `lib${base}`), join(fwdir, 'Headers'));
    writeFileSync(
      join(fwdir, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>CFBundleExecutable</key><string>${fw}</string>\n  <key>CFBundleIdentifier</key><string>org.ffmpeg.${fw}</string>\n  <key>CFBundleName</key><string>${fw}</string>\n  <key>CFBundlePackageType</key><string>FMWK</string>\n  <key>CFBundleShortVersionString</key><string>${version}</string>\n  <key>CFBundleVersion</key><string>${version}</string>\n  <key>MinimumOSVersion</key><string>${String(context.env['FW_MIN_OS'])}</string>\n  <key>CFBundleSupportedPlatforms</key><array><string>${String(context.env['FW_PLATFORM'])}</string></array>\n</dict>\n</plist>\n`,
    );
  }
  for (const fwdir of files(join(runDir, '*.framework'))) {
    const fw = basename(fwdir, '.framework');
    const bin = join(fwdir, fw);
    await run('install_name_tool', ['-id', `@rpath/${fw}.framework/${fw}`, bin], {
      env: context.env,
    });
    const refs = otoolLoads(await run('otool', ['-L', bin], { env: context.env, capture: true }));
    for (const ref of refs) {
      const stem = basename(ref).split('.')[0]!;
      if (/^lib(?:av|sw)/.test(stem)) {
        await run('install_name_tool', ['-change', ref, `@rpath/${stem}.framework/${stem}`, bin], {
          env: context.env,
        });
      }
    }
    await run('codesign', ['--force', '--sign', '-', bin], { env: context.env });
  }
  copyContents(join(install, 'include'), join(devDir, 'include'));
  stagePc(install, devDir, platform, context.depsDir);
}

/** The objdump for a Windows build: the cross toolchain's in the image, MSYS2's own natively. */
export const objdumpFor = (env: NodeJS.ProcessEnv): string =>
  env['CROSS_PREFIX'] ? `${env['CROSS_PREFIX']}-objdump` : 'objdump';

/** The thread stack a musl build's programs and libraries ask for (platforms.yml's -z stack-size): glibc's 8 MiB. */
const MUSL_THREAD_STACK = 8_388_608;

/**
 * Whether a staged file must ask musl for MUSL_THREAD_STACK: the programs and FFmpeg's own libraries. musl's dynamic
 * linker takes the largest PT_GNU_STACK of the program and the libraries it starts with (never of one dlopen'd later),
 * so these asking is what the programs, and any program linking FFmpeg's libraries at start-up, get; a runtime
 * library shipped next to them (libvulkan, which FFmpeg dlopens) is built by its own upstream's rules and needn't.
 */
export const asksMuslStack = (name: string): boolean =>
  name === 'ffmpeg' ||
  name === 'ffprobe' ||
  /^lib(?:avcodec|avdevice|avfilter|avformat|avutil|swresample|swscale|postproc)\.so(?:\.|$)/.test(
    name,
  );
/** Where MemSiz is among a readelf -lW program header's fields after its type. */
const GNU_STACK_MEMSIZ = 4;

/** The size an ELF file's PT_GNU_STACK asks for (its MemSiz), as `readelf -lW` prints it; undefined without one. */
export function gnuStackSize(readelf: string): number | undefined {
  const fields = /^\s*GNU_STACK\s+(.*)$/m.exec(readelf)?.[1]?.trim().split(/\s+/);
  // Offset VirtAddr PhysAddr FileSiz MemSiz Flg Align
  const memsiz = fields?.[GNU_STACK_MEMSIZ];
  return memsiz === undefined ? undefined : Number(memsiz);
}

/** A musl build links its C++ and GCC runtimes statically: no binary may need them as shared libraries. */
async function checkMuslRuntime(context: BuildContext, runDir: string): Promise<void> {
  for (const file of [
    join(runDir, 'ffmpeg'),
    join(runDir, 'ffprobe'),
    ...files(join(runDir, '*.so*')),
  ]) {
    if (!lstatSync(file).isSymbolicLink()) {
      const needed = await run('patchelf', ['--print-needed', file], {
        env: context.env,
        capture: true,
      });
      if (/^(libstdc\+\+|libgcc_s)\.so/m.test(needed)) {
        throw new Error(`${basename(file)} needs a shared C++ or GCC runtime`);
      }
      // musl's threads get 128 KiB of stack unless a program or library asks for more: FFmpeg's demux and encoder
      // threads need more (devenvy/ffmpeg-build#38)
      if (asksMuslStack(basename(file))) {
        const stack = gnuStackSize(
          await run('readelf', ['-lW', file], { env: context.env, capture: true }),
        );
        if (stack === undefined || stack < MUSL_THREAD_STACK) {
          throw new Error(
            `${basename(file)} asks musl for ${stack === undefined ? 'no' : `a ${stack}-byte`} thread stack, not ${MUSL_THREAD_STACK} (platforms.yml's -Wl,-z,stack-size)`,
          );
        }
      }
    }
  }
}

/** The LC_BUILD_VERSION platform number an Apple framework build must carry: iOS 2, Mac Catalyst 6, else 7. */
function appleBuildPlatform(platform: string): string {
  if (platform === 'ios-arm64') {
    return '2';
  }
  return platform.startsWith('maccatalyst-') ? '6' : '7';
}

async function checkPlatform(context: BuildContext, runDir: string): Promise<void> {
  const p = context.buildPlan.platform;
  if (context.buildPlan.setup === 'fake') {
    return;
  }
  if (p.startsWith('linux-')) {
    const prefix =
      p === 'linux-armhf'
        ? ['qemu-arm', '-L', `/usr/${String(context.env['CROSS_HOST'])}`, join(runDir, 'ffmpeg')]
        : [join(runDir, 'ffmpeg')];
    if (p.startsWith('linux-musl-')) {
      await checkMuslRuntime(context, runDir);
    }
    await run(prefix[0]!, [...prefix.slice(1), '-hide_banner', '-version'], { env: context.env });
    await run(prefix[0]!, [...prefix.slice(1), '-hide_banner', '-buildconf'], { env: context.env });
    return;
  }
  if (p.startsWith('win-')) {
    const runtime =
      /^(libgcc_s|libstdc\+\+|libwinpthread|libc\+\+|libunwind|libssp|libatomic|libgomp)[^/]*\.dll$|^vulkan-1\.dll$/i;
    for (const file of [...files(join(runDir, '*.dll')), ...files(join(runDir, '*.exe'))]) {
      const out = await run(objdumpFor(context.env), ['-p', file], {
        env: context.env,
        capture: true,
      });
      const bad = out
        .split(/\r?\n/)
        .map((line) => /^\s*DLL Name: (.*)$/.exec(line)?.[1])
        .filter((name) => name && runtime.test(name));
      if (bad.length) {
        throw new Error(`${basename(file)} imports ${bad.join(' ')}`);
      }
    }
    return;
  }
  if (p.startsWith('android-')) {
    const libdir = join(runDir, 'lib', context.env['ANDROID_ABI']!);
    if (
      !existsSync(join(libdir, 'libavcodec.so')) ||
      !existsSync(join(libdir, 'libc++_shared.so'))
    ) {
      throw new Error(
        `lib/${String(context.env['ANDROID_ABI'])} lacks libavcodec.so or libc++_shared.so`,
      );
    }
    if (
      !readFileSync(join(runDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8')
        .split(/\r?\n/)
        .includes('== libc++_shared.so ==')
    ) {
      throw new Error("THIRD-PARTY-NOTICES.txt lacks libc++_shared.so's licence text");
    }
    if (context.buildPlan.ffmpeg?.configure.includes('--enable-mediacodec')) {
      const needed = (
        await run('patchelf', ['--print-needed', join(libdir, 'libavcodec.so')], {
          env: context.env,
          capture: true,
        })
      ).split(/\r?\n/);
      if (!needed.includes('libmediandk.so')) {
        throw new Error("libavcodec.so doesn't need libmediandk.so, though mediacodec is enabled");
      }
    }
    const allowed = new Set([
      'libc.so',
      'libm.so',
      'libdl.so',
      'liblog.so',
      'libandroid.so',
      'libmediandk.so',
      'libcamera2ndk.so',
      'libvulkan.so',
      'libz.so',
      'libc++_shared.so',
    ]);
    for (const so of files(join(libdir, '*.so'))) {
      const load = await run(`${String(context.env['TOOLCHAIN'])}/bin/llvm-readelf`, ['-lW', so], {
        env: context.env,
        capture: true,
      });
      const aligns = load
        .split(/\r?\n/)
        .filter((line) => /^\s*LOAD\s/.test(line))
        .map((line) => Number(line.trim().split(/\s+/).at(-1)));
      if (!aligns.length || aligns.some((n) => n < ANDROID_PAGE_ALIGN)) {
        throw new Error(`${basename(so)} is not aligned for 16 KB pages`);
      }
      const soname = (
        await run('patchelf', ['--print-soname', so], { env: context.env, capture: true })
      ).trim();
      if (soname !== basename(so)) {
        throw new Error(`${basename(so)} has soname ${soname}`);
      }
      for (const dep of (
        await run('patchelf', ['--print-needed', so], { env: context.env, capture: true })
      )
        .split(/\r?\n/)
        .filter(Boolean)) {
        if (!allowed.has(dep) && !existsSync(join(libdir, dep))) {
          throw new Error(`${basename(so)} needs ${dep}, which the archive does not provide`);
        }
      }
    }
    return;
  }
  const bins = p.startsWith('osx-')
    ? [join(runDir, 'ffmpeg'), join(runDir, 'ffprobe'), ...files(join(runDir, '*.dylib'))]
    : files(join(runDir, '*.framework', 'lib*'));
  for (const bin of bins) {
    if (!lstatSync(bin).isSymbolicLink()) {
      const linked = await run('otool', ['-L', bin], { env: context.env, capture: true });
      const load = await run('otool', ['-l', bin], { env: context.env, capture: true });
      // what it loads must not be on this machine (the build folders, Homebrew, MacPorts, /usr/local); its text must not
      // name the build folders or the home folder (FFmpeg's own strings name /usr/local as a search path, which is fine)
      const machine = [
        context.work,
        context.depsDir,
        '/usr/local/',
        `${context.env['HOMEBREW_PREFIX'] ?? '/opt/homebrew'}/`,
        '/opt/homebrew/',
        '/opt/local/',
      ];
      const loads = otoolLoads(linked);
      const loaded = loads.find((dep) => machine.some((path) => dep.startsWith(path)));
      if (loaded) {
        throw new Error(`${basename(bin)} loads ${loaded}, which is on this machine`);
      }
      // strings -a of a big binary is searched as it streams, not kept
      const [named] = await searchOutput(
        'strings',
        ['-a', bin],
        [context.work, context.depsDir, context.env['HOME'] ?? ''],
        { env: context.env },
      );
      if (named) {
        throw new Error(
          `${basename(bin)} contains ${named.needle} (a build folder or the home folder) in its strings: ${named.line}`,
        );
      }
      const rpaths = [...load.matchAll(/cmd LC_RPATH[\s\S]*?path (\S+)/g)].map((m) => m[1]!);
      if (
        rpaths.some(
          (path) => !/^@(?:loader|executable)_path(?:\/|$)|^\/usr\/lib(?:\/|$)/.test(path),
        )
      ) {
        throw new Error(`${basename(bin)} has an unsafe LC_RPATH`);
      }
    }
  }
  if (p.startsWith('osx-')) {
    if (p === 'osx-x64' && process.arch === 'arm64' && !(await canRunX64(context.env))) {
      process.stdout.write(
        "not running the staged ffmpeg: this Mac can't run x86_64 programs (install Rosetta to)\n",
      );
      await run('lipo', ['-archs', join(runDir, 'ffmpeg')], { env: context.env });
    } else {
      await run(join(runDir, 'ffmpeg'), ['-hide_banner', '-version'], { env: context.env });
      await run(join(runDir, 'ffmpeg'), ['-hide_banner', '-buildconf'], { env: context.env });
    }
  } else {
    if (!existsSync(join(runDir, 'libavcodec.framework', 'Headers', 'avcodec.h'))) {
      throw new Error('libavcodec.framework has no Headers/avcodec.h');
    }
    const want = appleBuildPlatform(p);
    for (const bin of bins) {
      const out = await run('otool', ['-l', bin], { env: context.env, capture: true });
      const got = /LC_BUILD_VERSION[\s\S]*?\bplatform\s+(\d+)/.exec(out)?.[1];
      if (got !== want) {
        throw new Error(
          `${basename(bin)} is built for platform ${String(got)}, not ${want} (${p})`,
        );
      }
    }
  }
}

/** How many DWARF sections `objdump -h` lists. */
export const debugSections = (headers: string): number =>
  headers.split(/\r?\n/).filter((line) => /\s\.debug_\w+/.test(line)).length;

/** Where `nm` says a function is (a T or t symbol), as addr2line takes it. */
export function functionAddress(nm: string, name: string): string | undefined {
  for (const line of nm.split(/\r?\n/)) {
    const [address, type, symbol] = line.trim().split(/\s+/);
    if (symbol === name && (type === 'T' || type === 't')) {
      return `0x${address!}`;
    }
  }
  return undefined;
}

/**
 * The unstripped copies FFmpeg's build tree keeps of what `make install` strips as it installs: ffmpeg_g.exe and
 * ffprobe_g.exe, and lib<name>/<name>-<major>.dll for each of its DLLs. Keyed by the shipped file each is a copy of.
 */
export function unstrippedCopies(tree: string, shipped: readonly string[]): Map<string, string> {
  const copies = new Map<string, string>();
  for (const file of shipped) {
    const program = /^(ffmpeg|ffprobe)\.exe$/.exec(file);
    const dll = /^((?:av|sw|postproc)[a-z]*)-\d+\.dll$/.exec(file);
    if (program) {
      copies.set(file, join(tree, `${program[1]!}_g.exe`));
    } else if (dll) {
      copies.set(file, join(tree, `lib${dll[1]!}`, file));
    }
  }
  return copies;
}

/**
 * A Windows build's debug symbols (upstream's issue #20: symbolizing a crash dump's frames): the unstripped copies of
 * its programs and DLLs, with the notices, in `symbols`. Checked, not assumed: what ships carries no DWARF, and real
 * functions resolve to their source, in FFmpeg and (when whisper is in) in the ggml linked into libavfilter.
 */
async function stageSymbols(
  context: BuildContext,
  tree: string,
  runDir: string,
  symbols: string,
): Promise<void> {
  const env = context.env;
  const tools = env['CROSS_PREFIX'] ? `${env['CROSS_PREFIX']}-` : '';
  const shipped = [...files(join(runDir, '*.dll')), ...files(join(runDir, '*.exe'))];
  for (const file of shipped) {
    const n = debugSections(await run(objdumpFor(env), ['-h', file], { env, capture: true }));
    if (n) {
      throw new Error(`${basename(file)} carries ${n} DWARF sections: what ships must be stripped`);
    }
  }
  mkdirSync(symbols, { recursive: true });
  for (const [file, copy] of unstrippedCopies(
    tree,
    shipped.map((f) => basename(f)),
  )) {
    if (!existsSync(copy)) {
      throw new Error(`FFmpeg's build tree has no unstripped copy of ${file} (${copy})`);
    }
    copyFileSync(copy, join(symbols, basename(copy)));
  }
  copyFileSync(join(runDir, 'THIRD-PARTY-NOTICES.txt'), join(symbols, 'THIRD-PARTY-NOTICES.txt'));
  const avfilter = files(join(symbols, 'avfilter-*.dll'))[0];
  if (!avfilter) {
    throw new Error('no avfilter DLL among the symbols');
  }
  const resolves = async (symbol: string, source: string): Promise<void> => {
    const nm = await run(`${tools}nm`, [avfilter], { env, capture: true });
    const where = functionAddress(nm, symbol);
    if (!where) {
      throw new Error(`symbols: ${basename(avfilter)} has no function ${symbol}`);
    }
    const resolved = await run(`${tools}addr2line`, ['-f', '-C', '-i', '-e', avfilter, where], {
      env,
      capture: true,
    });
    const line = resolved.split(/\r?\n/)[1] ?? '';
    if (!line.includes(source)) {
      throw new Error(
        `symbols: ${basename(avfilter)}!${symbol} at ${where} resolves to "${line}", not ${source}`,
      );
    }
    process.stdout.write(`symbols: ${basename(avfilter)}!${symbol} -> ${line}\n`);
  };
  await resolves('avfilter_version', 'libavfilter/version.c');
  if (context.buildPlan.ffmpeg?.configure.includes('--enable-whisper')) {
    await resolves('ggml_init', 'ggml');
  }
}

/** Whether this Apple-silicon Mac runs x86_64 programs (Rosetta). */
export async function canRunX64(
  env: NodeJS.ProcessEnv,
  runner: typeof run = run,
): Promise<boolean> {
  try {
    await runner('arch', ['-x86_64', '/usr/bin/true'], { env, capture: true });
    return true;
  } catch {
    return false;
  }
}

export async function stageBuild(
  context: BuildContext,
  ffmpegDir: string,
  ffmpeg: SourceRecord,
  libraries: readonly SourceRecord[],
): Promise<void> {
  const plan = context.buildPlan;
  step(`staging ${plan.name}`);
  const runDir = join(context.work, 'stage', 'run');
  const devDir = join(context.work, 'stage', 'dev');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(devDir, { recursive: true });
  await stagePlatform(context, join(context.work, 'install'), runDir, devDir);
  const notice = join(runDir, 'THIRD-PARTY-NOTICES.txt');
  writeNotices(context, ffmpegDir, libraries, notice);
  copyFileSync(notice, join(devDir, 'THIRD-PARTY-NOTICES.txt'));
  checkNotices(notice, context);
  checkNotices(join(devDir, 'THIRD-PARTY-NOTICES.txt'), context);
  step(`checking ${plan.name}`);
  await checkPlatform(context, runDir);
  const symbolsDir =
    shipsSymbols(plan.platform) && plan.setup !== 'fake'
      ? join(context.work, 'stage', 'symbols')
      : undefined;
  if (symbolsDir) {
    step(`debug symbols of ${plan.name}`);
    await stageSymbols(context, ffmpegDir, runDir, symbolsDir);
  }
  await run('tar', ['-czf', join(context.out, `${plan.name}.tar.gz`), '-C', runDir, '.']);
  await run('tar', ['-czf', join(context.out, `${plan.name}-dev.tar.gz`), '-C', devDir, '.']);
  if (symbolsDir) {
    await run('tar', ['-czf', join(context.out, symbolsName(plan.name)), '-C', symbolsDir, '.']);
  }
  const record = {
    artifact: plan.name,
    target: plan.target,
    platform: plan.platform,
    license: plan.license,
    release: plan.release ?? null,
    ffmpeg,
    libraries,
    patches: plan.patches.map(({ name, sha256 }) => ({ name, sha256 })),
  };
  const recordPath = join(context.out, `${plan.name}.sources.json`);
  const temp = `${recordPath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, JSON_INDENT)}\n`);
  renameSync(temp, recordPath);
  const sourceOut = join(context.out, `${plan.name}.sources`);
  rmSync(sourceOut, { recursive: true, force: true });
  // (a Rust library's crates too)
  for (const { file: kept } of [ffmpeg, ...libraries].flatMap(keptFiles)) {
    // a record restored from the cache names its source: never anything outside the two sources folders
    const from = keptPath(context.sources, kept);
    const to = keptPath(sourceOut, kept);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  step(
    `done: ${plan.name}.tar.gz, ${plan.name}-dev.tar.gz, ${symbolsDir ? `${symbolsName(plan.name)}, ` : ''}${plan.name}.sources.json and the sources in ${plan.name}.sources/`,
  );
}
