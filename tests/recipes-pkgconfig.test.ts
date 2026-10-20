// Recipes whose bash only touched files around a standard build: .pc files written or edited, a symbol file, a
// bootstrap. Each test runs the recipe on every platform it builds on and compares the commands and files with what
// the old `shell:` step did, as read from it (quoted in the comments).
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  build,
  cmakeLines,
  commands,
  configureLine,
  type Harness,
  harness,
  mesonLines,
  pcPath,
  platformsOf,
} from './recipe-harness.ts';

import type * as RunModule from '../src/build/run.ts';

vi.mock('../src/build/run.ts', async (original) => ({
  ...(await original<typeof RunModule>()),
  run: vi.fn(),
}));

// a folder with an xxd in it, for libvmaf's check
let bin: string | undefined;
function tools(): string {
  if (bin) {
    return bin;
  }
  bin = mkdtempSync(join(tmpdir(), 'ffb-bin-'));
  writeFileSync(join(bin, 'xxd'), '#!/bin/sh\n');
  chmodSync(join(bin, 'xxd'), 0o755);
  return bin;
}

let made: Harness[] = [];
afterEach(() => {
  for (const h of made) {
    rmSync(h.root, { recursive: true, force: true });
  }
  made = [];
});
function fake(platform: string, options: Parameters<typeof harness>[1] = {}): Harness {
  const h = harness(platform, options);
  made.push(h);
  return h;
}

// The case statement chromaprint, libvmaf, libplacebo, shaderc and srt each had:
//   osx-*|ios-*|maccatalyst-*|android-*) -lc++ ;; win-arm64) -l:libc++.a ;; linux-musl-*) -l:libstdc++.a ;; *) -lstdc++
function bashCxxRt(platform: string): string {
  if (/^(osx|ios|maccatalyst|android)-/.test(platform)) {
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

// sed "s#^Libs\.private:.*#& X#" / "s#^Cflags:.*#& X#"
const sedAppend = (text: string, field: string, words: string) =>
  text.replace(new RegExp(`^${field.replace('.', '\\.')}:.*$`, 'gm'), `$& ${words}`);

describe('chromaprint', () => {
  // if grep -q '^Libs\.private:' pc; then sed -i "s#^Libs\.private:.*#& ${CXX_RT} -lm#"; else echo "Libs.private: ${CXX_RT} -lm" >>pc; fi
  // grep -q -- '-DCHROMAPRINT_NODLL' pc || sed -i 's#^Cflags:.*#& -DCHROMAPRINT_NODLL#' pc
  const installed = `prefix=/d\nName: chromaprint\nLibs: -L\${libdir} -lchromaprint\nLibs.private: \nCflags: -I\${includedir}\n`;
  it.each(platformsOf('chromaprint'))('%s', async (platform) => {
    const h = fake(platform);
    writeFileSync(pcPath(h, 'libchromaprint'), installed);
    await build(h, 'chromaprint');
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DBUILD_TOOLS=OFF',
        '-DBUILD_TESTS=OFF',
        '-DFFT_LIB=kissfft',
        `-DKISSFFT_SOURCE_DIR=${h.deps}/src/kissfft`,
      ]),
    );
    expect(h.read(pcPath(h, 'libchromaprint'))).toBe(
      sedAppend(
        sedAppend(installed, 'Libs.private', `${bashCxxRt(platform)} -lm`),
        'Cflags',
        '-DCHROMAPRINT_NODLL',
      ),
    );
  });
  it('adds a missing Libs.private at the end, and no second -DCHROMAPRINT_NODLL', async () => {
    const h = fake('linux-musl-x64');
    writeFileSync(
      pcPath(h, 'libchromaprint'),
      'Libs: -lchromaprint\nCflags: -I/x -DCHROMAPRINT_NODLL\n',
    );
    await build(h, 'chromaprint');
    expect(h.read(pcPath(h, 'libchromaprint'))).toBe(
      'Libs: -lchromaprint\nCflags: -I/x -DCHROMAPRINT_NODLL\nLibs.private: -l:libstdc++.a -lm\n',
    );
  });
});

describe('kvazaar', () => {
  // before: [[./autogen.sh]]; sed 's/-lrt//g' src/kvazaar.pc > deps/lib/pkgconfig/kvazaar.pc;
  // win-*: sed -i 's|^Cflags:.*|& -DKVZ_STATIC_LIB|'
  const generated = `prefix=/d\nLibs: -L\${libdir} -lkvazaar\nLibs.private: -lpthread -lrt -lm\nCflags: -I\${includedir}\n`;
  it.each(platformsOf('kvazaar'))('%s', async (platform) => {
    const h = fake(platform);
    mkdirSync(join(h.src, 'src'));
    writeFileSync(join(h.src, 'src', 'kvazaar.pc'), generated);
    await build(h, 'kvazaar');
    expect(commands(h)).toEqual([
      './autogen.sh',
      configureLine(h, [
        `--libdir=${h.deps}/lib`,
        '--disable-shared',
        '--enable-static',
        '--with-pic',
      ]),
      'make -j4 -C src libkvazaar.la',
      'make -C src install-libLTLIBRARIES install-includeHEADERS',
    ]);
    const sedded = generated.replaceAll('-lrt', '');
    expect(h.read(pcPath(h, 'kvazaar'))).toBe(
      platform.startsWith('win-') ? sedAppend(sedded, 'Cflags', '-DKVZ_STATIC_LIB') : sedded,
    );
  });
});

describe('libjxl', () => {
  // case: osx|ios|maccatalyst -lc++; android -lc++ -llog; win-arm64 -l:libc++.a; linux-musl -l:libstdc++.a; else -lstdc++
  // for each of libjxl.pc, libjxl_threads.pc: the words not already on a Libs/Libs.private line (as a word) go to the end
  // of Libs.private, or a new `Libs.private:${add}` line at the end of the file.
  const jxlRt = (platform: string) =>
    platform.startsWith('android-') ? '-lc++ -llog' : bashCxxRt(platform);
  const jxl = `Name: libjxl\nLibs: -L\${libdir} -ljxl\nLibs.private: -lm -lstdc++\nCflags: -I\${includedir}\n`;
  const threads = `Name: libjxl_threads\nLibs: -L\${libdir} -ljxl_threads\nCflags: -I\${includedir}\n`;
  it.each(platformsOf('libjxl'))('%s', async (platform) => {
    const h = fake(platform);
    writeFileSync(pcPath(h, 'libjxl'), jxl);
    writeFileSync(pcPath(h, 'libjxl_threads'), threads);
    await build(h, 'libjxl');
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        `-DCMAKE_FIND_ROOT_PATH=${h.deps}`,
        '-DBUILD_TESTING=OFF',
        '-DJPEGXL_ENABLE_TOOLS=OFF',
        '-DJPEGXL_ENABLE_BENCHMARK=OFF',
        '-DJPEGXL_ENABLE_EXAMPLES=OFF',
        '-DJPEGXL_ENABLE_MANPAGES=OFF',
        '-DJPEGXL_ENABLE_DOXYGEN=OFF',
        '-DJPEGXL_ENABLE_JPEGLI=OFF',
        '-DJPEGXL_ENABLE_PLUGINS=OFF',
        '-DJPEGXL_ENABLE_SKCMS=OFF',
        '-DJPEGXL_ENABLE_SJPEG=OFF',
        '-DJPEGXL_ENABLE_TRANSCODE_JPEG=OFF',
        '-DJPEGXL_FORCE_SYSTEM_BROTLI=ON',
        '-DJPEGXL_FORCE_SYSTEM_HWY=ON',
        '-DJPEGXL_FORCE_SYSTEM_LCMS2=ON',
      ]),
    );
    const add = jxlRt(platform)
      .split(' ')
      .filter((w) => w !== '-lstdc++'); // -lstdc++ is already on libjxl.pc's line
    expect(h.read(pcPath(h, 'libjxl'))).toBe(
      add.length ? sedAppend(jxl, 'Libs.private', add.join(' ')) : jxl,
    );
    expect(h.read(pcPath(h, 'libjxl_threads'))).toBe(
      `${threads}Libs.private: ${jxlRt(platform)}\n`,
    );
  });
});

describe('libplacebo', () => {
  // sed -i.bak "s|^Libs.private:.*|& ${CXX_RT_LIB}|", else sed -i.bak "/^Libs:/a Libs.private: ${CXX_RT_LIB}"
  const args = [
    '-Dvulkan=enabled',
    '-Dshaderc=enabled',
    '-Dglslang=disabled',
    '-Dopengl=disabled',
    '-Ddemos=false',
    '-Dtests=false',
    '-Dlcms=enabled',
    '-Dd3d11=disabled',
    '-Dvk-proc-addr=disabled',
  ];
  it('builds wherever Vulkan does: Apple (MoltenVK) too, but not the lean iOS simulator slice', () => {
    expect(platformsOf('libplacebo')).toEqual(
      expect.arrayContaining(['osx-arm64', 'osx-x64', 'ios-arm64', 'maccatalyst-arm64']),
    );
    expect(platformsOf('libplacebo')).not.toContain('ios-sim-arm64');
  });
  it.each(platformsOf('libplacebo'))('%s', async (platform) => {
    const h = fake(platform);
    const pc = `Name: libplacebo\nLibs: -L\${libdir} -lplacebo\nLibs.private: -lm -pthread\nCflags: -I\${includedir}\n`;
    writeFileSync(pcPath(h, 'libplacebo'), pc);
    await build(h, 'libplacebo');
    // the submodules are fetched with the source now (see recipe-steps.test.ts); nothing runs before meson
    expect(commands(h)).toEqual(mesonLines(h, args));
    expect(h.read(pcPath(h, 'libplacebo'))).toBe(
      sedAppend(pc, 'Libs.private', bashCxxRt(platform)),
    );
  });
  it('puts a missing Libs.private after Libs:', async () => {
    const h = fake('win-arm64');
    writeFileSync(
      pcPath(h, 'libplacebo'),
      `Name: libplacebo\nLibs: -L\${libdir} -lplacebo\nCflags: -I\${includedir}\n`,
    );
    await build(h, 'libplacebo');
    expect(h.read(pcPath(h, 'libplacebo'))).toBe(
      `Name: libplacebo\nLibs: -L\${libdir} -lplacebo\nLibs.private: -l:libc++.a\nCflags: -I\${includedir}\n`,
    );
  });
  it('fetches the four submodules, shallow', async () => {
    const { recipe } = await import('./recipe-harness.ts');
    const { submoduleArgs } = await import('../src/build/fetch.ts');
    const source = recipe('libplacebo').source;
    // until git submodule update --init --depth 1 3rdparty/glad 3rdparty/jinja 3rdparty/markupsafe 3rdparty/fast_float
    expect('git' in source && source.submodules && submoduleArgs(source.submodules)).toEqual([
      'submodule',
      'update',
      '--init',
      '--depth',
      '1',
      '3rdparty/glad',
      '3rdparty/jinja',
      '3rdparty/markupsafe',
      '3rdparty/fast_float',
    ]);
  });
});

describe('libva', () => {
  // for libva libva-drm: [ -f ] || continue; grep -q '^Libs.private:' && sed 's/^Libs.private:.*/Libs.private: -ldl/' || sed '/^Libs:/a Libs.private: -ldl'
  it.each(platformsOf('libva'))('%s', async (platform) => {
    const h = fake(platform);
    writeFileSync(
      pcPath(h, 'libva'),
      `Name: libva\nLibs: -L\${libdir} -lva\nLibs.private: -lm\nCflags: -I\${includedir}\n`,
    );
    writeFileSync(
      pcPath(h, 'libva-drm'),
      `Name: libva-drm\nLibs: -L\${libdir} -lva-drm\nCflags: -I\${includedir}\n`,
    );
    mkdirSync(join(h.src, 'va'));
    writeFileSync(join(h.src, 'va', 'meson.build'), "libva = shared_library('va')\n");
    await build(h, 'libva');
    expect(commands(h)).toEqual(
      mesonLines(h, [
        '-Dwith_x11=no',
        '-Dwith_glx=no',
        '-Dwith_wayland=no',
        '-Dwith_win32=no',
        '-Ddisable_drm=false',
      ]),
    );
    expect(h.read(pcPath(h, 'libva'))).toBe(
      `Name: libva\nLibs: -L\${libdir} -lva\nLibs.private: -ldl\nCflags: -I\${includedir}\n`,
    );
    expect(h.read(pcPath(h, 'libva-drm'))).toBe(
      `Name: libva-drm\nLibs: -L\${libdir} -lva-drm\nLibs.private: -ldl\nCflags: -I\${includedir}\n`,
    );
  });
  it('skips a .pc that was not installed', async () => {
    const h = fake('linux-x64');
    mkdirSync(join(h.src, 'va'));
    writeFileSync(join(h.src, 'va', 'meson.build'), "libva = shared_library('va')\n");
    await build(h, 'libva');
    expect(h.files(h.deps)).toEqual([]);
  });
});

describe('libvmaf', () => {
  // win-arm64: sed -i "s/\bswap(/libsvm_swap(/g" libvmaf/src/svm.cpp; command -v xxd || exit 1;
  // linux-x64|linux-musl-x64|win-x64|osx-x64|maccatalyst-x64|android-x64: nasm -v must say >= 2.14;
  // after: Libs.private gets ${CXX_RT} (or a line at the end)
  const x64 = [
    'linux-x64',
    'linux-musl-x64',
    'win-x64',
    'osx-x64',
    'maccatalyst-x64',
    'android-x64',
  ];
  it.each(platformsOf('libvmaf'))('%s', async (platform) => {
    const h = fake(platform, { path: tools() });
    h.onRun = (call) =>
      call.command === 'nasm' ? 'NASM version 2.16.03 compiled on Apr 17 2024\n' : undefined;
    mkdirSync(join(h.src, 'libvmaf', 'src'), { recursive: true });
    const svm =
      'template <class T> static inline void swap(T& x, T& y) {}\n  swap(a, b); std::swap(c, d); myswap(e);\n';
    writeFileSync(join(h.src, 'libvmaf', 'src', 'svm.cpp'), svm);
    const pc = `Name: libvmaf\nLibs: -L\${libdir} -lvmaf\nLibs.private: -lm -lpthread\n`;
    writeFileSync(pcPath(h, 'libvmaf'), pc);
    await build(h, 'libvmaf');
    expect(commands(h)).toEqual([
      ...(x64.includes(platform) ? ['libvmaf$ nasm -v'] : []),
      ...mesonLines(
        h,
        [
          '-Denable_tests=false',
          '-Denable_docs=false',
          '-Dbuilt_in_models=true',
          '-Denable_float=true',
        ],
        'libvmaf',
      ),
    ]);
    expect(h.read(join(h.src, 'libvmaf', 'src', 'svm.cpp'))).toBe(
      platform === 'win-arm64'
        ? 'template <class T> static inline void libsvm_swap(T& x, T& y) {}\n  libsvm_swap(a, b); std::libsvm_swap(c, d); myswap(e);\n'
        : svm,
    );
    expect(h.read(pcPath(h, 'libvmaf'))).toBe(sedAppend(pc, 'Libs.private', bashCxxRt(platform)));
  });
  it('fails without xxd, and with a nasm older than 2.14', async () => {
    const h = fake('linux-arm64', { path: join(tools(), 'empty') });
    await expect(build(h, 'libvmaf')).rejects.toThrow(/xxd not found/);
    const old = fake('linux-x64', { path: tools() });
    old.onRun = () => 'NASM version 2.13.02\n';
    await expect(build(old, 'libvmaf')).rejects.toThrow(/older than 2.14.*found 2.13.02/s);
  });
  it('adds a missing Libs.private at the end', async () => {
    const h = fake('android-arm64', { path: tools() });
    writeFileSync(pcPath(h, 'libvmaf'), 'Libs: -lvmaf\n');
    await build(h, 'libvmaf');
    expect(h.read(pcPath(h, 'libvmaf'))).toBe('Libs: -lvmaf\nLibs.private: -lc++\n');
  });
});

describe('libmp3lame', () => {
  // sed -i.bak '/lame_init_old/d' include/libmp3lame.sym; ios-*/maccatalyst-*: ac_cv_header_stdc=yes (unchanged)
  it.each(platformsOf('libmp3lame'))('%s', async (platform) => {
    const h = fake(platform);
    mkdirSync(join(h.src, 'include'));
    writeFileSync(
      join(h.src, 'include', 'libmp3lame.sym'),
      'lame_init\nlame_init_old\nlame_close\n',
    );
    await build(h, 'libmp3lame');
    const env = /^(ios|maccatalyst)-/.test(platform) ? ' [ac_cv_header_stdc=yes]' : '';
    expect(commands(h)).toEqual([
      configureLine(
        h,
        [
          '--disable-shared',
          '--enable-static',
          '--disable-frontend',
          '--disable-decoder',
          '--enable-nasm',
          '--with-pic',
        ],
        env,
      ),
      `make -j4${env}`,
      `make install${env}`,
    ]);
    expect(h.read(join(h.src, 'include', 'libmp3lame.sym'))).toBe('lame_init\nlame_close\n');
    expect(h.files(h.src)).toEqual(['include/libmp3lame.sym']);
  });
  it("leaves 4.0's symbol file alone: it no longer lists lame_init_old", async () => {
    const h = fake('linux-x64');
    mkdirSync(join(h.src, 'include'));
    writeFileSync(join(h.src, 'include', 'libmp3lame.sym'), 'lame_init\nlame_close\n');
    await build(h, 'libmp3lame');
    expect(h.read(join(h.src, 'include', 'libmp3lame.sym'))).toBe('lame_init\nlame_close\n');
  });
});

describe('openjpeg', () => {
  // [ -f pc ] && sed -i.bak -E 's/-l(-l?pthread)/\1/g' libopenjp2.pc
  it.each(platformsOf('openjpeg'))('%s', async (platform) => {
    const h = fake(platform);
    writeFileSync(
      pcPath(h, 'libopenjp2'),
      `Libs: -L\${libdir} -lopenjp2\nLibs.private: -lm -l-lpthread -l-pthread\n`,
    );
    await build(h, 'openjpeg');
    expect(commands(h)).toEqual(cmakeLines(h, ['-DBUILD_CODEC=OFF', '-DBUILD_TESTING=OFF']));
    expect(h.read(pcPath(h, 'libopenjp2'))).toBe(
      `Libs: -L\${libdir} -lopenjp2\nLibs.private: -lm -lpthread -pthread\n`,
    );
  });
  it('is a no-op without the .pc', async () => {
    const h = fake('linux-x64');
    await build(h, 'openjpeg');
    expect(h.files(h.deps)).toEqual([]);
  });
});

describe('speex', () => {
  // ./autogen.sh >/dev/null 2>&1 || autoreconf -fi
  it.each(platformsOf('speex'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'speex');
    expect(commands(h)).toEqual([
      './autogen.sh',
      configureLine(h, ['--disable-shared', '--enable-static', '--with-pic', '--disable-binaries']),
      'make -j4',
      'make install',
    ]);
    expect(h.calls[0]!.capture).toBe(true);
  });
  it('falls back to autoreconf -fi', async () => {
    const h = fake('linux-x64');
    h.onRun = (call) => {
      if (call.command === './autogen.sh') {
        throw new Error('autogen.sh failed');
      }
    };
    await build(h, 'speex');
    expect(commands(h).slice(0, 2)).toEqual(['./autogen.sh', 'autoreconf -fi']);
    expect(h.calls[1]!.capture).toBe(false);
  });
});

describe('openh264', () => {
  // cat > openh264.pc <<PC (prefix, libdir, includedir, blank, Name, Description, Version: ${VERSION#v}, Libs, Libs.private, Cflags)
  it.each(platformsOf('openh264'))('%s', async (platform) => {
    const h = fake(platform, { version: '2.6.0' });
    writeFileSync(pcPath(h, 'openh264'), 'installed by meson\n');
    await build(h, 'openh264');
    expect(commands(h)).toEqual(mesonLines(h, ['-Dtests=disabled']));
    expect(h.read(pcPath(h, 'openh264'))).toBe(
      `prefix=${h.deps}\nlibdir=\${prefix}/lib\nincludedir=\${prefix}/include\n\nName: openh264\nDescription: OpenH264 — Cisco H.264 codec\nVersion: 2.6.0\nLibs: -L\${libdir} -lopenh264\nLibs.private: -lstdc++ -lm\nCflags: -I\${includedir}\n`,
    );
  });
});

describe('x265', () => {
  // case: osx-*|android-*|ios-*|maccatalyst-*) -lc++ -lm; win-*) -lstdc++ -lm; *) -lstdc++ -lm -lpthread
  const priv = (p: string): string => {
    if (/^(osx|android|ios|maccatalyst)-/.test(p)) {
      return '-lc++ -lm';
    }
    return p.startsWith('win-') ? '-lstdc++ -lm' : '-lstdc++ -lm -lpthread';
  };
  it.each(platformsOf('x265'))('%s', async (platform) => {
    const h = fake(platform, { version: '4.1' });
    await build(h, 'x265');
    const noAsm = platform === 'linux-armhf' || /^(osx|android|ios|maccatalyst)-/.test(platform);
    expect(commands(h)).toEqual(
      cmakeLines(
        h,
        [
          '-DLIB_INSTALL_DIR=lib',
          '-DENABLE_SHARED=OFF',
          '-DENABLE_CLI=OFF',
          '-DENABLE_LIBNUMA=OFF',
          ...(noAsm ? ['-DENABLE_ASSEMBLY=OFF'] : []),
        ],
        'source',
      ),
    );
    expect(h.read(pcPath(h, 'x265'))).toBe(
      `prefix=${h.deps}\nexec_prefix=\${prefix}\nlibdir=\${prefix}/lib\nincludedir=\${prefix}/include\n\nName: x265\nDescription: H.265/HEVC video encoder\nVersion: 4.1\nLibs: -L\${libdir} -lx265\nLibs.private: ${priv(platform)}\nCflags: -I\${includedir}\n`,
    );
  });
});

describe('vulkan-headers', () => {
  // VK_HEADER_VERSION's value (awk $3); 1.4 if VK_API_VERSION_1_4 is defined, else 1.3, else exit 1
  const header = (apis: string[]) =>
    [
      ...apis.map((v) => `#define VK_API_VERSION_${v} VK_MAKE_API_VERSION(0, 1, 3, 0)`),
      '#define VK_HEADER_VERSION 330',
      '',
    ].join('\n');
  const vulkanPc = (h: Harness, version: string) =>
    `prefix=${h.deps}\nincludedir=\${prefix}/include\n\nName: Vulkan-Headers\nDescription: Vulkan header-only SDK for FFmpeg configure checks\nVersion: ${version}\nCflags: -I\${includedir}\n`;
  it.each(platformsOf('vulkan-headers'))('%s', async (platform) => {
    const h = fake(platform);
    mkdirSync(join(h.deps, 'include', 'vulkan'));
    writeFileSync(
      join(h.deps, 'include', 'vulkan', 'vulkan_core.h'),
      header(['1_0', '1_3', '1_4']),
    );
    await build(h, 'vulkan-headers');
    expect(commands(h)).toEqual(cmakeLines(h, []));
    expect(h.read(pcPath(h, 'vulkan'))).toBe(vulkanPc(h, '1.4.330'));
  });
  it('says 1.3 for 1.3 headers and fails on older ones', async () => {
    const h = fake('linux-x64');
    mkdirSync(join(h.deps, 'include', 'vulkan'));
    writeFileSync(join(h.deps, 'include', 'vulkan', 'vulkan_core.h'), header(['1_2', '1_3']));
    await build(h, 'vulkan-headers');
    expect(h.read(pcPath(h, 'vulkan'))).toBe(vulkanPc(h, '1.3.330'));
    writeFileSync(join(h.deps, 'include', 'vulkan', 'vulkan_core.h'), header(['1_2']));
    await expect(build(h, 'vulkan-headers')).rejects.toThrow(
      'Vulkan support requires Vulkan 1.3+ headers.',
    );
  });
});
