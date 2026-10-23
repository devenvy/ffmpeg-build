import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from './helpers.ts';
import { configureFlags, makeBuildPlan, verifyNames } from '../src/build/plan.ts';
import { SETUPS } from '../src/build/toolchain.ts';
import { checkProfile } from '../src/check.ts';
import { optionFacts } from '../src/commands/options.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { formatReport } from '../src/format.ts';
import { packageRoot } from '../src/paths.ts';
import { PLATFORMS } from '../src/platforms.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';
import { parseFolderText, targetProfile } from '../src/targets.ts';

const data = loadEngineData(packageRoot);
const shippedPath = join(packageRoot, 'profiles', 'devenvy.yml');
const folder = (() => {
  const r = parseFolderText(readFileSync(shippedPath, 'utf8'), join(packageRoot, 'profiles'));
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return r.folder;
})();
// each target is one build: its own plan, at the versions devenvy 9.0.2.3 shipped
const cells = folder.targets.map((t) => {
  const plan = planProfile(targetProfile(folder, t), data, { '8': '8.1.3', '9': '9.0.2' });
  if (plan.errors.length) {
    throw new Error(`${t.name}: ${plan.errors.join('\n')}`);
  }
  return plan.cells[0]!;
});
const linux = (license: string, series = '9') =>
  cells.find(
    (c) =>
      c.cell.platform === 'linux-x64' && c.cell.license === license && c.cell.series === series,
  )!;

// `ffmpeg -buildconf` of the published ffmpeg-9.0.2-linux-x64-lgplv3.tar.gz (devenvy/ffmpeg release 9.0.2.3),
// minus the base and license flags: the option flags today's build passes.
const PUBLISHED_LGPLV3_LINUX_X64 = [
  'cuda',
  'cuvid',
  'nvenc',
  'nvdec',
  'ffnvcodec',
  'vaapi',
  'libdrm',
  'libvpl',
  'v4l2-m2m',
  'libvpx',
  'libopenh264',
  'libkvazaar',
  'libdav1d',
  'zlib',
  'lcms2',
  'libxml2',
  'libfreetype',
  'libfribidi',
  'libharfbuzz',
  'libfontconfig',
  'libass',
  'libvorbis',
  'libopus',
  'libmp3lame',
  'libspeex',
  'libgsm',
  'libopencore-amrnb',
  'libopencore-amrwb',
  'libvo-amrwbenc',
  'libsoxr',
  'libaom',
  'libsvtav1',
  'libwebp',
  'libopenjpeg',
  'libzimg',
  'libvmaf',
  'openssl',
  'libsrt',
  'librist',
  'libjxl',
  'chromaprint',
  'vulkan',
  'whisper',
  'libplacebo',
].map((f) => f.replaceAll('-', '_').toUpperCase());
describe('profiles/devenvy.yml', () => {
  it('has a target for every build devenvy/ffmpeg publishes', () => {
    expect(cells).toHaveLength(folder.targets.length);
    expect(folder.targets.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'linux-x64-lgplv3',
        'win-arm64-gplv2',
        'ios-sim-arm64-lgplv3-ffmpeg8',
      ]),
    );
  });

  it('passes check from the command line, copied into a folder of its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-shipped-'));
    copyFileSync(shippedPath, join(dir, 'ffmpeg-build.yml'));
    const r = runCli(['check'], { cwd: dir });
    expect(r.stdout).not.toContain('✗');
    expect(r.exitCode).toBe(0);
  });

  it("passes today's linux-x64 lgplv3 configure flags (as a set)", () => {
    expect([...configureFlags(data, linux('lgplv3'))].sort()).toEqual([
      '--disable-autodetect',
      '--disable-debug',
      '--disable-doc',
      '--disable-ffplay',
      '--disable-gpl',
      '--disable-nonfree',
      '--disable-static',
      '--enable-chromaprint',
      '--enable-cuda',
      '--enable-cuvid',
      '--enable-ffmpeg',
      '--enable-ffnvcodec',
      '--enable-ffprobe',
      '--enable-lcms2',
      '--enable-libaom',
      '--enable-libass',
      '--enable-libdav1d',
      '--enable-libdrm',
      '--enable-libfontconfig',
      '--enable-libfreetype',
      '--enable-libfribidi',
      '--enable-libgsm',
      '--enable-libharfbuzz',
      '--enable-libjxl',
      '--enable-libkvazaar',
      '--enable-libmp3lame',
      '--enable-libopencore-amrnb',
      '--enable-libopencore-amrwb',
      '--enable-libopenh264',
      '--enable-libopenjpeg',
      '--enable-libopus',
      '--enable-libplacebo',
      '--enable-librist',
      '--enable-libsoxr',
      '--enable-libspeex',
      '--enable-libsrt',
      '--enable-libsvtav1',
      '--enable-libvmaf',
      '--enable-libvo-amrwbenc',
      '--enable-libvorbis',
      '--enable-libvpl',
      '--enable-libvpx',
      '--enable-libwebp',
      '--enable-libxml2',
      '--enable-libzimg',
      '--enable-nvdec',
      '--enable-nvenc',
      '--enable-openssl',
      '--enable-pic',
      '--enable-pthreads',
      '--enable-shared',
      '--enable-v4l2-m2m',
      '--enable-vaapi',
      '--enable-version3',
      '--enable-vulkan',
      '--enable-vulkan-static',
      '--enable-whisper',
      '--enable-zlib',
      '--extra-cflags=-I/opt/ffmpeg-build/deps/include',
      '--extra-ldflags=-L/opt/ffmpeg-build/deps/lib',
      '--extra-libs=-lm',
      '--extra-libs=-lpthread -ldl',
      '--pkg-config-flags=--static',
    ]);
  });

  it("builds today's published linux-x64 lgplv3 options with a static Vulkan loader", () => {
    expect([...verifyNames(data, linux('lgplv3'))].sort()).toEqual(
      [...PUBLISHED_LGPLV3_LINUX_X64, 'VULKAN_STATIC'].sort(),
    );
  });

  it('restores the published configure and verify sets with the shared Vulkan override', () => {
    const cell = linux('lgplv3');
    const shared = { ...cell, linkages: { ...cell.linkages, 'vulkan-loader': 'shared' as const } };
    expect(configureFlags(data, shared)).toEqual(
      configureFlags(data, cell).filter((flag) => flag !== '--enable-vulkan-static'),
    );
    expect([...verifyNames(data, shared)].sort()).toEqual([...PUBLISHED_LGPLV3_LINUX_X64].sort());
  });

  it('gives each linux-x64 license the libraries it allows', () => {
    const has = (license: string, lib: string, series = '9') =>
      linux(license, series).recipes.includes(lib);
    // TLS: openssl for v3, gnutls for gplv2, none for lgplv2
    expect([
      linux('lgplv3').groups['tls'],
      linux('gplv3').groups['tls'],
      linux('gplv2').groups['tls'],
      linux('lgplv2').groups['tls'],
    ]).toEqual(['openssl', 'openssl', 'gnutls', undefined]);
    // Apache-2.0 only in v3: Vulkan, placebo (through shaderc), AMR
    for (const lib of ['vulkan-loader', 'libplacebo', 'shaderc', 'opencore-amr', 'vo-amrwbenc']) {
      expect([
        has('lgplv3', lib),
        has('gplv3', lib),
        has('gplv2', lib),
        has('lgplv2', lib),
      ]).toEqual([true, true, false, false]);
    }
    // GPL encoders only in GPL builds, kvazaar only in LGPL ones
    for (const lib of ['x264', 'x265']) {
      expect([
        has('gplv3', lib),
        has('gplv2', lib),
        has('lgplv3', lib),
        has('lgplv2', lib),
      ]).toEqual([true, true, false, false]);
    }
    expect([
      has('lgplv3', 'kvazaar'),
      has('lgplv2', 'kvazaar'),
      has('gplv3', 'kvazaar'),
      has('gplv2', 'kvazaar'),
    ]).toEqual([true, true, false, false]);
    // srt/rist encrypt through mbedTLS everywhere but lgplv2; whisper everywhere, on Vulkan only where it's allowed
    expect([
      has('lgplv3', 'mbedtls'),
      has('gplv3', 'mbedtls'),
      has('gplv2', 'mbedtls'),
      has('lgplv2', 'mbedtls'),
    ]).toEqual([true, true, true, false]);
    for (const license of ['lgplv3', 'gplv3', 'gplv2', 'lgplv2']) {
      expect(linux(license).options).toContain('whisper');
    }
    // shaderc is FFmpeg 8 only
    expect(linux('lgplv3', '8').options).toContain('shaderc');
    expect(linux('lgplv3').options).not.toContain('shaderc');
  });

  it('builds linux-musl-x64 as upstream does: libvpl, but no v4l2-m2m', () => {
    const musl = cells.find(
      (c) =>
        c.cell.platform === 'linux-musl-x64' &&
        c.cell.license === 'lgplv3' &&
        c.cell.series === '9',
    )!;
    expect(musl.options).toContain('vpl');
    expect(musl.options).not.toContain('v4l2-m2m');
    expect(linux('lgplv3').options).toContain('v4l2-m2m');
  });

  it('builds on every platform platforms.yml lists, with a toolchain definition and image for each', () => {
    for (const [platform, entry] of data.platforms) {
      expect(SETUPS as readonly string[], platform).toContain(entry.setup);
    }
    const dockerBuilt = [...data.platforms].filter(([, entry]) => entry.image !== 'macos');
    for (const [platform, entry] of dockerBuilt) {
      expect(existsSync(join(packageRoot, 'images', entry.image, 'Dockerfile')), platform).toBe(
        true,
      );
    }
    expect([...data.platforms.keys()]).toContain('linux-musl-x64');
  });

  it("builds osx-arm64 with Apple's own media and TLS frameworks, and whisper on Metal", () => {
    const osx = cells.find(
      (c) =>
        c.cell.platform === 'osx-arm64' && c.cell.license === 'lgplv3' && c.cell.series === '9',
    )!;
    for (const option of ['videotoolbox', 'audiotoolbox', 'securetransport', 'whisper']) {
      expect(osx.options).toContain(option);
    }
    // v3: Vulkan through the Khronos loader and MoltenVK, and libplacebo, as upstream
    for (const option of ['vulkan', 'placebo']) {
      expect(osx.options).toContain(option);
    }
    expect(osx.recipes).toEqual(expect.arrayContaining(['vulkan-loader', 'moltenvk']));
    expect(data.platforms.get('osx-arm64')).toMatchObject({ image: 'macos', setup: 'apple-macos' });
    const linuxOnly = cells.find(
      (c) =>
        c.cell.platform === 'linux-x64' && c.cell.license === 'lgplv3' && c.cell.series === '9',
    )!;
    expect(linuxOnly.options).not.toContain('videotoolbox');
  });

  // ffmpeg.exe's embedded configure line in the published 9.0.2.3 win-x64 lgplv3 artifact, minus --prefix and --extra-*
  it("passes today's published win-x64 lgplv3 configure flags (as a set)", () => {
    const win = cells.find(
      (c) => c.cell.platform === 'win-x64' && c.cell.license === 'lgplv3' && c.cell.series === '9',
    )!;
    const flags = configureFlags(data, win).filter(
      (f) => !f.startsWith('--extra-') && !f.startsWith('--prefix'),
    );
    expect([...flags].sort()).toEqual([
      '--arch=x86_64',
      '--cc=x86_64-w64-mingw32-gcc-win32',
      '--cross-prefix=x86_64-w64-mingw32-',
      '--cxx=x86_64-w64-mingw32-g++-win32',
      '--disable-autodetect',
      '--disable-debug',
      '--disable-doc',
      '--disable-ffplay',
      '--disable-gpl',
      '--disable-nonfree',
      '--disable-static',
      '--enable-amf',
      '--enable-chromaprint',
      '--enable-cross-compile',
      '--enable-cuda',
      '--enable-cuvid',
      '--enable-d3d11va',
      '--enable-dxva2',
      '--enable-ffmpeg',
      '--enable-ffnvcodec',
      '--enable-ffprobe',
      '--enable-lcms2',
      '--enable-libaom',
      '--enable-libass',
      '--enable-libdav1d',
      '--enable-libfreetype',
      '--enable-libfribidi',
      '--enable-libgsm',
      '--enable-libharfbuzz',
      '--enable-libjxl',
      '--enable-libkvazaar',
      '--enable-libmp3lame',
      '--enable-libopencore-amrnb',
      '--enable-libopencore-amrwb',
      '--enable-libopenh264',
      '--enable-libopenjpeg',
      '--enable-libopus',
      '--enable-libplacebo',
      '--enable-librist',
      '--enable-libsoxr',
      '--enable-libspeex',
      '--enable-libsrt',
      '--enable-libsvtav1',
      '--enable-libvmaf',
      '--enable-libvo-amrwbenc',
      '--enable-libvorbis',
      '--enable-libvpl',
      '--enable-libvpx',
      '--enable-libwebp',
      '--enable-libxml2',
      '--enable-libzimg',
      '--enable-mediafoundation',
      '--enable-nvdec',
      '--enable-nvenc',
      '--enable-schannel',
      '--enable-shared',
      '--enable-version3',
      '--enable-vulkan',
      '--enable-w32threads',
      '--enable-whisper',
      '--enable-zlib',
      '--pkg-config-flags=--static',
      '--pkg-config=pkg-config',
      '--target-os=mingw32',
    ]);
  });

  it('cross-compiles osx-x64 on Apple silicon, and gives maccatalyst-x64 its x86_64 target', () => {
    const cell = (platform: string) =>
      cells.find(
        (c) => c.cell.platform === platform && c.cell.license === 'lgplv3' && c.cell.series === '9',
      )!;
    const osx = configureFlags(data, cell('osx-x64'));
    expect(osx).toEqual(expect.arrayContaining(['--arch=x86_64', '--enable-cross-compile']));
    expect(osx.filter((f) => f.startsWith('--extra-cflags=')).join(' ')).toContain('-arch x86_64');
    expect(configureFlags(data, cell('maccatalyst-x64'))).toEqual(
      expect.arrayContaining(['--arch=x86_64', '--enable-cross-compile', '--target-os=darwin']),
    );
    expect(configureFlags(data, cell('ios-sim-arm64'))).toEqual(
      expect.arrayContaining(['--arch=aarch64', '--enable-cross-compile', '--target-os=darwin']),
    );
  });

  it('builds SPIR-V headers for whisper only where its Vulkan backend builds', () => {
    // (Apple v3 builds them for FFmpeg's own Vulkan, through MoltenVK; v2 has no Vulkan there)
    const cell = (platform: string, license = 'lgplv3') =>
      cells.find(
        (c) => c.cell.platform === platform && c.cell.license === license && c.cell.series === '9',
      )!;
    for (const platform of ['ios-sim-arm64', 'ios-arm64', 'osx-arm64', 'maccatalyst-arm64']) {
      expect(cell(platform, 'lgplv2').recipes, platform).toContain('whisper.cpp');
      expect(cell(platform, 'lgplv2').recipes, platform).not.toContain('spirv-headers'); // Metal backend
    }
    expect(cell('linux-x64').recipes).toContain('spirv-headers');
  });

  it('keeps the iOS simulator slice lean', () => {
    const sim = cells.find(
      (c) =>
        c.cell.platform === 'ios-sim-arm64' && c.cell.license === 'lgplv3' && c.cell.series === '9',
    )!;
    // turned down by the target (their libraries build for the simulator); the rest don't build there at all
    const target = folder.targets.find((t) => t.name === 'ios-sim-arm64-lgplv3')!;
    expect(target.without).toEqual(
      expect.arrayContaining(['vpx', 'kvazaar', 'opus', 'aom', 'freetype', 'fribidi', 'harfbuzz']),
    );
    expect(sim.options).toContain('whisper'); // published 9.0.2.3: the simulator slice has whisper (Metal)
    for (const option of [
      'vpx',
      'x264',
      'x265',
      'kvazaar',
      'opus',
      'aom',
      'freetype',
      'fribidi',
      'harfbuzz',
      'fontconfig',
      'ass',
      'vulkan',
      'placebo',
    ]) {
      expect(sim.options).not.toContain(option);
    }
  });
});

describe('Windows Vulkan', () => {
  it('brings the SPIR-V headers with vulkan, with or without whisper', () => {
    const r = parseProfileText(
      'name: t\nffmpeg: 9\nplatforms: [win-x64]\nlicense: lgplv3\nwith: [vulkan]\n',
      't.yml',
    );
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    const cell = planProfile(r.profile, data, { '9': '9.0.2' }).cells[0]!;
    expect(cell.recipes).toEqual(['spirv-headers', 'vulkan-headers']);
  });

  it('options --json names each platform library with its licence and platforms', () => {
    const vulkan = optionFacts(data, '9').find((o) => o.name === 'vulkan')!;
    expect(vulkan.libraries).toEqual([
      {
        name: 'vulkan-loader',
        spdx: 'Apache-2.0',
        platforms: [
          'linux-x64',
          'linux-arm64',
          'linux-musl-x64',
          'linux-musl-arm64',
          'osx-x64',
          'osx-arm64',
        ],
      },
      {
        name: 'vulkan-headers',
        spdx: 'Apache-2.0 OR MIT',
        platforms: ['linux-armhf', 'win-x64', 'win-arm64', 'android-arm64', 'android-x64'],
      },
      {
        name: 'moltenvk',
        spdx: 'Apache-2.0',
        platforms: ['ios-arm64', 'maccatalyst-x64', 'maccatalyst-arm64'],
      },
    ]);
  });
});

// Upstream ran FFmpeg's Vulkan on Apple through MoltenVK (Vulkan-over-Metal): on macOS the Khronos loader with the
// MoltenVK dylib and its ICD manifest beside it, on iOS and Mac Catalyst MoltenVK linked statically into the libav*
// frameworks. Both are Apache-2.0, so v3 only; the lean ios-sim-arm64 slice has neither.
describe('Vulkan on Apple (MoltenVK)', () => {
  const apple = /^(osx|ios|maccatalyst)-/;
  const profileOf = (platform: string) => {
    const r = parseProfileText(
      `name: t\nffmpeg: 9\nplatforms: [${platform}]\nlicense: lgplv3\nwith: [vulkan, placebo]\n`,
      't.yml',
    );
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    return r.profile;
  };
  const planOf = (platform: string) =>
    planProfile(profileOf(platform), data, { '8': '8.1.3', '9': '9.0.2' });

  it('options --json offers vulkan and placebo on every Apple platform but the simulator slice', () => {
    for (const name of ['vulkan', 'placebo']) {
      const option = optionFacts(data, '9').find((o) => o.name === name)!;
      expect(option.platforms.filter((p) => apple.test(p)).sort(), name).toEqual([
        'ios-arm64',
        'maccatalyst-arm64',
        'maccatalyst-x64',
        'osx-arm64',
        'osx-x64',
      ]);
    }
  });

  it.each(['osx-arm64', 'osx-x64'])('%s selects its verified native MoltenVK route', (platform) => {
    const cell = planOf(platform).cells[0]!;
    expect(cell.recipes).toEqual(
      expect.arrayContaining([
        'vulkan-headers',
        'spirv-headers',
        'moltenvk',
        'vulkan-loader',
        'shaderc',
        'libplacebo',
      ]),
    );
    const flags = configureFlags(data, cell);
    expect(flags).toEqual(expect.arrayContaining(['--enable-vulkan', '--enable-libplacebo']));
    const direct = platform === 'osx-arm64';
    expect(flags.includes('--enable-vulkan-static')).toBe(direct);
    expect(flags.some((flag) => flag.includes('-framework AppKit'))).toBe(direct);
  });

  it('macOS x64 retains the shared driver route; arm64 and iOS embed their selected owner', () => {
    const runtimeOf = (platform: string) => {
      const cell = planOf(platform).cells[0]!;
      return makeBuildPlan({
        profile: profileOf(platform),
        data,
        locked: {
          ffmpeg: { '9': '9.0.2' },
          libraries: Object.fromEntries(cell.recipes.map((r) => [r, '1.0.0'])),
          pinned: [],
        },
        cell,
        variant: 'lgplv3',
        imageId: 'x',
        cacheDir: mkdtempSync(join(tmpdir(), 'c-')),
      }).runtime;
    };
    expect(runtimeOf('osx-arm64')).toEqual([]);
    expect(runtimeOf('osx-x64').sort()).toEqual([
      'lib/MoltenVK_icd.json',
      'lib/libMoltenVK.dylib',
      'lib/libvulkan*.dylib',
    ]);
    expect(runtimeOf('ios-arm64')).toEqual([]);
  });

  it.each(['ios-arm64', 'maccatalyst-arm64', 'maccatalyst-x64'])(
    '%s links MoltenVK statically, with the frameworks it calls',
    (platform) => {
      const cell = planOf(platform).cells[0]!;
      expect(cell.recipes).toContain('moltenvk');
      expect(cell.recipes).not.toContain('vulkan-loader');
      const flags = configureFlags(data, cell);
      expect(flags).toEqual(
        expect.arrayContaining([
          '--enable-vulkan',
          '--enable-vulkan-static',
          '--extra-libs=-lc++ -framework Metal -framework IOSurface -framework Foundation -framework QuartzCore -framework CoreGraphics -framework UIKit',
          '--enable-libplacebo',
        ]),
      );
      expect(flags.includes('--extra-libs=-framework IOKit')).toBe(
        platform.startsWith('maccatalyst-'),
      );
      expect(verifyNames(data, cell)).toEqual(
        expect.arrayContaining(['VULKAN', 'VULKAN_STATIC', 'LIBPLACEBO']),
      );
    },
  );

  it('check refuses Vulkan on a v2 Apple target: MoltenVK and the loader are Apache-2.0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-mac-vulkan-'));
    writeFileSync(
      join(dir, 'ffmpeg-build.yml'),
      'targets:\n  mac: { platform: osx-arm64, license: lgplv2, ffmpeg: 9, with: [vulkan] }\n',
    );
    const r = runCli(['check'], { cwd: dir });
    expect(r.stdout).toContain('Apache-2.0');
    expect(r.exitCode).toBe(1);
  });

  it('check accepts Vulkan and placebo on a v3 macOS target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-mac-vulkan-'));
    writeFileSync(
      join(dir, 'ffmpeg-build.yml'),
      'targets:\n  mac: { platform: osx-arm64, license: lgplv3, ffmpeg: 9, with: [vulkan, placebo] }\n',
    );
    const r = runCli(['check'], { cwd: dir });
    expect(r.stdout).not.toContain('✗');
    expect(r.exitCode).toBe(0);
  });

  it("isn't offered on the lean iOS simulator slice", () => {
    const sim = planOf('ios-sim-arm64').cells[0]!;
    expect(sim.options).not.toContain('vulkan');
    expect(sim.options).not.toContain('placebo');
    expect(sim.recipes).not.toContain('moltenvk');
  });
});

// devenvy/ffmpeg's matrix (docs/matrix/ffmpeg-*-*v3.md): Vulkan, libplacebo and (FFmpeg 8) shaderc on every v3
// Apple target; MoltenVK statically on iOS and Mac Catalyst, with the loader on macOS; none of it on v2.
describe('Apple Vulkan in the shipped targets', () => {
  const apple = ['osx-arm64', 'osx-x64', 'ios-arm64', 'maccatalyst-arm64', 'maccatalyst-x64'];
  it.each(apple)('%s v3 builds vulkan, placebo and (FFmpeg 8) shaderc; v2 none', (platform) => {
    const targets = cells.filter((x) => x.cell.platform === platform);
    expect(targets.map((x) => x.cell.license)).toEqual(
      expect.arrayContaining(['gplv3', 'lgplv3', 'gplv2', 'lgplv2']),
    );
    for (const c of targets) {
      const { license, series } = c.cell;
      const v3 = license.endsWith('v3');
      const want = ['vulkan', 'placebo', ...(series === '8' ? ['shaderc'] : [])];
      for (const option of want) {
        expect(c.options.includes(option), `${platform} ${license} ${series} ${option}`).toBe(v3);
      }
      expect(c.recipes.includes('moltenvk'), `${platform} ${license} ${series}`).toBe(v3);
      expect(c.recipes.includes('vulkan-loader')).toBe(v3 && platform.startsWith('osx-'));
      expect(configureFlags(data, c).includes('--enable-vulkan-static')).toBe(
        v3 && platform !== 'osx-x64',
      );
    }
  });
});

// The published 9.0.2.3 lgplv3 artifacts' embedded configure lines (libavutil), minus --prefix, --extra-* and the
// toolchain paths (--cc, --sysroot, ...) that name the build machine.
describe("linux-armhf and Android plan the published builds' configure flags", () => {
  const flagsOf = (platform: string) => {
    const c = cells.find(
      (x) => x.cell.platform === platform && x.cell.license === 'lgplv3' && x.cell.series === '9',
    )!;
    return [
      ...configureFlags(data, c).filter(
        (f) => !f.startsWith('--extra-') && !f.startsWith('--prefix'),
      ),
    ].sort();
  };

  it('linux-armhf plans the published flags', () => {
    expect(flagsOf('linux-armhf')).toEqual([
      '--arch=arm',
      '--cpu=armv7-a+vfpv3',
      '--cross-prefix=arm-linux-gnueabihf-',
      '--disable-autodetect',
      '--disable-debug',
      '--disable-doc',
      '--disable-ffplay',
      '--disable-gpl',
      '--disable-nonfree',
      '--disable-static',
      '--enable-chromaprint',
      '--enable-cross-compile',
      '--enable-ffmpeg',
      '--enable-ffprobe',
      '--enable-lcms2',
      '--enable-libaom',
      '--enable-libass',
      '--enable-libdav1d',
      '--enable-libfontconfig',
      '--enable-libfreetype',
      '--enable-libfribidi',
      '--enable-libgsm',
      '--enable-libharfbuzz',
      '--enable-libjxl',
      '--enable-libkvazaar',
      '--enable-libmp3lame',
      '--enable-libopencore-amrnb',
      '--enable-libopencore-amrwb',
      '--enable-libopenh264',
      '--enable-libopenjpeg',
      '--enable-libopus',
      '--enable-libplacebo',
      '--enable-librist',
      '--enable-libsoxr',
      '--enable-libspeex',
      '--enable-libsrt',
      '--enable-libvmaf',
      '--enable-libvo-amrwbenc',
      '--enable-libvorbis',
      '--enable-libvpx',
      '--enable-libwebp',
      '--enable-libxml2',
      '--enable-libzimg',
      '--enable-openssl',
      '--enable-pic',
      '--enable-pthreads',
      '--enable-shared',
      '--enable-v4l2-m2m',
      '--enable-version3',
      '--enable-vulkan',
      '--enable-whisper',
      '--enable-zlib',
      '--pkg-config-flags=--static',
      '--pkg-config=pkg-config',
      '--target-os=linux',
    ]);
  });

  // Android: the published flags less --enable-hwaccel=h264_mediacodec and hevc_mediacodec, which matched nothing
  it('android-arm64 plans the published flags', () => {
    expect(flagsOf('android-arm64')).toEqual([
      '--arch=aarch64',
      '--disable-autodetect',
      '--disable-debug',
      '--disable-doc',
      '--disable-gpl',
      '--disable-nonfree',
      '--disable-programs',
      '--disable-static',
      '--enable-chromaprint',
      '--enable-cross-compile',
      '--enable-decoder=h264_mediacodec',
      '--enable-decoder=hevc_mediacodec',
      '--enable-jni',
      '--enable-lcms2',
      '--enable-libaom',
      '--enable-libass',
      '--enable-libdav1d',
      '--enable-libfreetype',
      '--enable-libfribidi',
      '--enable-libgsm',
      '--enable-libharfbuzz',
      '--enable-libjxl',
      '--enable-libkvazaar',
      '--enable-libmp3lame',
      '--enable-libopencore-amrnb',
      '--enable-libopencore-amrwb',
      '--enable-libopenh264',
      '--enable-libopenjpeg',
      '--enable-libopus',
      '--enable-libplacebo',
      '--enable-librist',
      '--enable-libsoxr',
      '--enable-libspeex',
      '--enable-libsrt',
      '--enable-libvmaf',
      '--enable-libvo-amrwbenc',
      '--enable-libvorbis',
      '--enable-libvpx',
      '--enable-libxml2',
      '--enable-libzimg',
      '--enable-mediacodec',
      '--enable-openssl',
      '--enable-pic',
      '--enable-pthreads',
      '--enable-shared',
      '--enable-version3',
      '--enable-vulkan',
      '--enable-whisper',
      '--enable-zlib',
      '--pkg-config-flags=--static',
      '--target-os=android',
    ]);
  });

  it('android-x64 plans the published flags', () => {
    expect(flagsOf('android-x64')).toEqual([
      '--arch=x86_64',
      '--disable-autodetect',
      '--disable-debug',
      '--disable-doc',
      '--disable-gpl',
      '--disable-nonfree',
      '--disable-programs',
      '--disable-static',
      '--enable-chromaprint',
      '--enable-cross-compile',
      '--enable-decoder=h264_mediacodec',
      '--enable-decoder=hevc_mediacodec',
      '--enable-jni',
      '--enable-lcms2',
      '--enable-libaom',
      '--enable-libass',
      '--enable-libdav1d',
      '--enable-libfreetype',
      '--enable-libfribidi',
      '--enable-libgsm',
      '--enable-libharfbuzz',
      '--enable-libjxl',
      '--enable-libkvazaar',
      '--enable-libmp3lame',
      '--enable-libopencore-amrnb',
      '--enable-libopencore-amrwb',
      '--enable-libopenh264',
      '--enable-libopenjpeg',
      '--enable-libopus',
      '--enable-libplacebo',
      '--enable-librist',
      '--enable-libsoxr',
      '--enable-libspeex',
      '--enable-libsrt',
      '--enable-libvmaf',
      '--enable-libvo-amrwbenc',
      '--enable-libvorbis',
      '--enable-libvpx',
      '--enable-libxml2',
      '--enable-libzimg',
      '--enable-mediacodec',
      '--enable-openssl',
      '--enable-pic',
      '--enable-pthreads',
      '--enable-shared',
      '--enable-version3',
      '--enable-vulkan',
      '--enable-whisper',
      '--enable-zlib',
      '--pkg-config-flags=--static',
      '--target-os=android',
    ]);
  });

  it('builds Vulkan from the headers alone on linux-armhf and Android, without the loader', () => {
    for (const platform of ['linux-armhf', 'android-arm64', 'android-x64']) {
      const c = cells.find(
        (x) => x.cell.platform === platform && x.cell.license === 'lgplv3' && x.cell.series === '9',
      )!;
      expect(c.recipes).toContain('vulkan-headers');
      expect(c.recipes).not.toContain('vulkan-loader');
    }
  });
});

describe('Android ships the NDK libc++', () => {
  it('names libc++_shared.so and its licence, which every license allows', () => {
    for (const platform of ['android-arm64', 'android-x64']) {
      expect(data.platforms.get(platform)!.ships).toEqual({
        'libc++_shared.so': {
          license: 'Apache-2.0 WITH LLVM-exception',
          notice: `\${TOOLCHAIN}/NOTICE`,
        },
      });
    }
    const lgplv2 = parseProfileText(
      'name: t\nffmpeg: 9\nplatforms: [android-arm64]\nlicense: lgplv2\nwith: [dav1d]\n',
      't.yml',
    );
    expect(formatReport(checkProfile(lgplv2, data))).not.toContain('✗');
  });

  it('puts the mediacodec decoders on the mediacodec option, not the platform', () => {
    const flags = data.platforms.get('android-arm64')!.configure;
    expect(flags.some((f) => f.includes('mediacodec'))).toBe(false);
    const c = cells.find(
      (x) =>
        x.cell.platform === 'android-arm64' && x.cell.license === 'lgplv3' && x.cell.series === '9',
    )!;
    expect(configureFlags(data, c)).toEqual(
      expect.arrayContaining([
        '--enable-mediacodec',
        '--enable-decoder=h264_mediacodec',
        '--enable-decoder=hevc_mediacodec',
      ]),
    );
  });
});

describe('verifying component flags', () => {
  it('checks --enable-<kind>=<name> as the CONFIG_<NAME>_<KIND> FFmpeg sets', () => {
    const c = cells.find(
      (x) =>
        x.cell.platform === 'android-arm64' && x.cell.license === 'lgplv3' && x.cell.series === '9',
    )!;
    expect(verifyNames(data, c)).toEqual(
      expect.arrayContaining([
        'MEDIACODEC',
        'JNI',
        'H264_MEDIACODEC_DECODER',
        'HEVC_MEDIACODEC_DECODER',
      ]),
    );
    expect(verifyNames(data, c).some((n) => n.includes('='))).toBe(false);
  });
});

// The published 9.0.2.3 lgplv3 artifacts' configure lines (libavutil) minus --prefix and the --extra-* build paths:
// upstream builds both natively on arm64, so they carry no cross flags.
describe("linux-arm64 and linux-musl-arm64 plan the published builds' configure flags", () => {
  const of = (platform: string) =>
    cells.find(
      (x) => x.cell.platform === platform && x.cell.license === 'lgplv3' && x.cell.series === '9',
    )!;
  const flagsOf = (platform: string) =>
    [
      ...configureFlags(data, of(platform)).filter(
        (f) => !f.startsWith('--extra-') && !f.startsWith('--prefix'),
      ),
    ].sort();

  it('linux-arm64 plans the published flags', () => {
    expect(flagsOf('linux-arm64')).toEqual([
      '--disable-autodetect',
      '--disable-debug',
      '--disable-doc',
      '--disable-ffplay',
      '--disable-gpl',
      '--disable-nonfree',
      '--disable-static',
      '--enable-chromaprint',
      '--enable-cuda',
      '--enable-cuvid',
      '--enable-ffmpeg',
      '--enable-ffnvcodec',
      '--enable-ffprobe',
      '--enable-lcms2',
      '--enable-libaom',
      '--enable-libass',
      '--enable-libdav1d',
      '--enable-libdrm',
      '--enable-libfontconfig',
      '--enable-libfreetype',
      '--enable-libfribidi',
      '--enable-libgsm',
      '--enable-libharfbuzz',
      '--enable-libjxl',
      '--enable-libkvazaar',
      '--enable-libmp3lame',
      '--enable-libopencore-amrnb',
      '--enable-libopencore-amrwb',
      '--enable-libopenh264',
      '--enable-libopenjpeg',
      '--enable-libopus',
      '--enable-libplacebo',
      '--enable-librist',
      '--enable-libsoxr',
      '--enable-libspeex',
      '--enable-libsrt',
      '--enable-libsvtav1',
      '--enable-libvmaf',
      '--enable-libvo-amrwbenc',
      '--enable-libvorbis',
      '--enable-libvpx',
      '--enable-libwebp',
      '--enable-libxml2',
      '--enable-libzimg',
      '--enable-nvdec',
      '--enable-nvenc',
      '--enable-openssl',
      '--enable-pic',
      '--enable-pthreads',
      '--enable-shared',
      '--enable-v4l2-m2m',
      '--enable-vaapi',
      '--enable-version3',
      '--enable-vulkan',
      '--enable-whisper',
      '--enable-zlib',
      '--pkg-config-flags=--static',
    ]);
  });

  it('linux-musl-arm64 plans the published flags', () => {
    expect(flagsOf('linux-musl-arm64')).toEqual([
      '--disable-autodetect',
      '--disable-debug',
      '--disable-doc',
      '--disable-ffplay',
      '--disable-gpl',
      '--disable-nonfree',
      '--disable-static',
      '--enable-chromaprint',
      '--enable-cuda',
      '--enable-cuvid',
      '--enable-ffmpeg',
      '--enable-ffnvcodec',
      '--enable-ffprobe',
      '--enable-lcms2',
      '--enable-libaom',
      '--enable-libass',
      '--enable-libdav1d',
      '--enable-libdrm',
      '--enable-libfontconfig',
      '--enable-libfreetype',
      '--enable-libfribidi',
      '--enable-libgsm',
      '--enable-libharfbuzz',
      '--enable-libjxl',
      '--enable-libkvazaar',
      '--enable-libmp3lame',
      '--enable-libopencore-amrnb',
      '--enable-libopencore-amrwb',
      '--enable-libopenh264',
      '--enable-libopenjpeg',
      '--enable-libopus',
      '--enable-libplacebo',
      '--enable-librist',
      '--enable-libsoxr',
      '--enable-libspeex',
      '--enable-libsrt',
      '--enable-libsvtav1',
      '--enable-libvmaf',
      '--enable-libvo-amrwbenc',
      '--enable-libvorbis',
      '--enable-libvpx',
      '--enable-libwebp',
      '--enable-libxml2',
      '--enable-libzimg',
      '--enable-nvdec',
      '--enable-nvenc',
      '--enable-openssl',
      '--enable-pic',
      '--enable-pthreads',
      '--enable-shared',
      '--enable-v4l2-m2m',
      '--enable-vaapi',
      '--enable-version3',
      '--enable-vulkan',
      '--enable-whisper',
      '--enable-zlib',
      '--pkg-config-flags=--static',
    ]);
  });

  it('defines both in platforms.yml and builds them with the Vulkan loader, which they ship, and without libvpl (x86 only)', () => {
    for (const platform of ['linux-arm64', 'linux-musl-arm64']) {
      expect(of(platform).recipes).toContain('vulkan-loader');
      expect(of(platform).options).not.toContain('vpl');
      expect(data.platforms.get(platform)).toBeDefined();
    }
  });
});

// iconv, bzlib and lzma: none of them names a component of its own (they work inside existing ones: subtitle
// character sets, bzip2-compressed Matroska tracks, LZMA-compressed TIFF), so the checks are what each platform builds
// and passes. FFmpeg probes the C library's iconv even under --disable-autodetect (glibc, musl and Android's have
// it); Windows has none and Apple's is a library of its own, so those build GNU libiconv and link it.
describe('iconv, bzlib and lzma', () => {
  const ownLibiconv = /^(win|osx|ios|maccatalyst)-/;
  const planOn = (platform: string) => {
    const r = parseProfileText(
      `name: t\nffmpeg: 9\nplatforms: [${platform}]\nlicense: lgplv2\nwith: [iconv, bzlib, lzma]\n`,
      't.yml',
    );
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    const plan = planProfile(r.profile, data, { '9': '9.0.2' });
    expect(plan.errors).toEqual([]);
    return plan.cells[0]!;
  };

  it.each(PLATFORMS)('%s builds bzip2 and xz, and libiconv where the system has no iconv', (p) => {
    const cell = planOn(p);
    expect(cell.options).toEqual(['bzlib', 'iconv', 'lzma']);
    expect([...cell.recipes].sort()).toEqual(
      ownLibiconv.test(p) ? ['bzip2', 'libiconv', 'xz'] : ['bzip2', 'xz'],
    );
    const flags = configureFlags(data, cell);
    expect(flags).toEqual(
      expect.arrayContaining(['--enable-iconv', '--enable-bzlib', '--enable-lzma']),
    );
    expect(flags.includes('--extra-libs=-liconv')).toBe(ownLibiconv.test(p));
  });

  it('options offers each on every platform and in every license', () => {
    for (const name of ['iconv', 'bzlib', 'lzma']) {
      const option = optionFacts(data, '9').find((o) => o.name === name)!;
      expect(option.platforms, name).toEqual(PLATFORMS);
      expect(option.licenses, name).toEqual(['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree']);
    }
    expect(optionFacts(data, '9').find((o) => o.name === 'iconv')!.libraries).toEqual([
      {
        name: 'libiconv',
        spdx: 'LGPL-2.1-or-later',
        platforms: PLATFORMS.filter((p) => ownLibiconv.test(p)),
      },
    ]);
  });

  it('turns on in no shipped target', () => {
    for (const c of cells) {
      expect(c.options.filter((o) => ['iconv', 'bzlib', 'lzma'].includes(o))).toEqual([]);
    }
  });
});

// Batch b of #21, GPU and hardware: each can be listed where FFmpeg and the platform can do it, and `check` says why
// not everywhere else. None turns on by itself.
describe('cuda-llvm, opencl, d3d12va, vdpau and rkmpp', () => {
  const GPU = ['cuda-llvm', 'opencl', 'd3d12va', 'vdpau', 'rkmpp'];
  const linuxAll = PLATFORMS.filter((p) => p.startsWith('linux-'));
  const nvidia = ['linux-x64', 'linux-arm64', 'linux-musl-x64', 'linux-musl-arm64', 'win-x64'];
  const rockchip = ['linux-arm64', 'linux-armhf', 'linux-musl-arm64'];
  const icd = [...linuxAll, 'win-x64', 'win-arm64'];
  // where each builds, and what it builds and passes there
  const where: Record<
    string,
    { platforms: string[]; recipes: (p: string) => string[]; flags: string[] }
  > = {
    // nv-codec's headers; the CUDA kernels are compiled to PTX by the image's clang (llvm-mingw's on Windows)
    'cuda-llvm': {
      platforms: nvidia,
      recipes: () => ['nv-codec'],
      flags: ['--enable-ffnvcodec', '--enable-cuda', '--enable-cuda-llvm'],
    },
    // the Khronos ICD loader on Linux and Windows; macOS's own OpenCL framework
    opencl: {
      platforms: [...icd, 'osx-x64', 'osx-arm64'],
      recipes: (p) => (p.startsWith('osx-') ? [] : ['opencl-headers', 'opencl-icd-loader']),
      flags: ['--enable-opencl'],
    },
    // a newer mingw-w64's D3D12 video headers for win-x64; llvm-mingw has them
    d3d12va: {
      platforms: ['win-x64', 'win-arm64'],
      recipes: (p) => (p === 'win-x64' ? ['d3d12-headers'] : []),
      flags: ['--enable-d3d12va'],
    },
    vdpau: { platforms: linuxAll, recipes: () => ['libvdpau'], flags: ['--enable-vdpau'] },
    rkmpp: {
      platforms: rockchip,
      recipes: () => ['libdrm', 'rockchip-mpp'],
      flags: ['--enable-rkmpp', '--enable-libdrm'],
    },
  };
  const text = (platform: string, license: string, option: string) =>
    `name: t\nffmpeg: 9\nplatforms: [${platform}]\nlicense: ${license}\nwith: [${option}]\n`;
  const planOn = (platform: string, license: string, option: string) => {
    const r = parseProfileText(text(platform, license, option), 't.yml');
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    return planProfile(r.profile, data, { '9': '9.0.2' });
  };
  const report = (platform: string, license: string, option: string) =>
    formatReport(checkProfile(parseProfileText(text(platform, license, option), 't.yml'), data));

  const builds = GPU.flatMap((o) => where[o]!.platforms.map((p) => [o, p] as const));
  it.each(builds)('%s builds on %s', (option, platform) => {
    const plan = planOn(platform, 'gplv3', option);
    expect(plan.errors).toEqual([]);
    const cell = plan.cells[0]!;
    expect(cell.options).toEqual([option]);
    expect([...cell.recipes].sort()).toEqual(where[option]!.recipes(platform));
    const flags = configureFlags(data, cell);
    expect(flags).toEqual(expect.arrayContaining(where[option]!.flags));
    // cuda-llvm is the CUDA filters alone: NVENC, NVDEC and CUVID stay nvenc's
    expect(flags.filter((f) => /--enable-(nvenc|nvdec|cuvid)$/.test(f))).toEqual([]);
  });

  // what `check` says where it can't be built
  const reasons: Record<string, (p: string) => string> = {
    'cuda-llvm': (p) =>
      /^(linux|win)-/.test(p)
        ? "the nv-codec recipe doesn't build there"
        : "FFmpeg doesn't support cuda-llvm there",
    opencl: () => "FFmpeg doesn't support opencl there",
    d3d12va: () => "FFmpeg doesn't support d3d12va there",
    vdpau: () => "FFmpeg doesn't support vdpau there",
    rkmpp: (p) =>
      p.startsWith('linux-')
        ? "the rockchip-mpp recipe doesn't build there"
        : "FFmpeg doesn't support rkmpp there",
  };
  const absent = GPU.flatMap((o) =>
    PLATFORMS.filter((p) => !where[o]!.platforms.includes(p)).map((p) => [o, p] as const),
  );
  it.each(absent)('%s is unavailable on %s, and check says why', (option, platform) => {
    expect(planOn(platform, 'gplv3', option).cells[0]?.options ?? []).not.toContain(option);
    expect(report(platform, 'gplv3', option)).toContain(
      `not on ${platform}: ${reasons[option]!(platform)}`,
    );
  });

  it('keeps rkmpp (FFmpeg: version3) and the Apache-2.0 OpenCL loader out of v2 builds', () => {
    for (const license of ['lgplv2', 'gplv2']) {
      expect(report('linux-arm64', license, 'rkmpp')).toContain('✗');
      expect(report('linux-x64', license, 'opencl')).toContain('✗');
      // macOS's OpenCL is the system's: nothing to license
      expect(planOn('osx-arm64', license, 'opencl').errors).toEqual([]);
    }
  });

  it('options offers each where it builds, in the licenses that allow it', () => {
    const facts = optionFacts(data, '9');
    const of = (name: string) => facts.find((o) => o.name === name)!;
    for (const name of GPU) {
      expect(of(name).platforms, name).toEqual(where[name]!.platforms);
    }
    const all = ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree'];
    const v3 = ['lgplv3', 'gplv3', 'nonfree'];
    expect(of('cuda-llvm').licenses).toEqual(all);
    expect(of('d3d12va').licenses).toEqual(all);
    expect(of('vdpau').licenses).toEqual(all);
    expect(of('rkmpp').licenses).toEqual(v3);
    expect(of('opencl').licenses).toEqual(v3);
  });

  it('turns on in no shipped target', () => {
    for (const c of cells) {
      expect(c.options.filter((o) => GPU.includes(o))).toEqual([]);
    }
  });
});

// Batch c of #21, codecs: each can be listed where its library builds, in the licenses its library (and FFmpeg's own
// class) allow, and `check` says why not elsewhere. None turns on by itself.
describe('codec libraries', () => {
  const ALL = ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree'];
  const V3 = ['lgplv3', 'gplv3', 'nonfree'];
  const GPL = ['gplv2', 'gplv3', 'nonfree'];
  const NOT_ARMHF = PLATFORMS.filter((p) => p !== 'linux-armhf');
  const AVS2 = [
    'linux-x64',
    'linux-arm64',
    'linux-musl-x64',
    'linux-musl-arm64',
    'win-x64',
    'android-arm64',
    'android-x64',
  ];
  const where: Record<
    string,
    {
      platforms: readonly string[];
      recipes: string[];
      flags: string[];
      licenses: string[];
      ships: Record<string, string[]>;
    }
  > = {
    theora: {
      platforms: PLATFORMS,
      recipes: ['libogg', 'libtheora'],
      flags: ['--enable-libtheora'],
      licenses: ALL,
      ships: { encoders: ['libtheora'] },
    },
    // FFmpeg's class gpl
    xvid: {
      platforms: PLATFORMS,
      recipes: ['xvidcore'],
      flags: ['--enable-libxvid', '--extra-libs=-lm'],
      licenses: GPL,
      ships: { encoders: ['libxvid'] },
    },
    vvenc: {
      platforms: PLATFORMS.filter((p) => p !== 'linux-armhf'),
      recipes: ['vvenc'],
      flags: ['--enable-libvvenc'],
      licenses: ALL,
      ships: { encoders: ['libvvenc'] },
    },
    twolame: {
      platforms: PLATFORMS,
      recipes: ['twolame'],
      flags: ['--enable-libtwolame', '--extra-libs=-lm'],
      licenses: ALL,
      ships: { encoders: ['libtwolame'] },
    },
    shine: {
      platforms: PLATFORMS,
      recipes: ['shine'],
      flags: ['--enable-libshine'],
      licenses: ALL,
      ships: { encoders: ['libshine'] },
    },
    // Apache-2.0: not GPLv2-compatible
    lc3: {
      platforms: PLATFORMS,
      recipes: ['liblc3'],
      flags: ['--enable-liblc3'],
      licenses: V3,
      ships: { encoders: ['liblc3'], decoders: ['liblc3'] },
    },
    codec2: {
      platforms: PLATFORMS,
      recipes: ['codec2'],
      flags: ['--enable-libcodec2', '--extra-libs=-lm'],
      licenses: ALL,
      ships: { encoders: ['libcodec2'], decoders: ['libcodec2'] },
    },
    // abseil's headers (Apache-2.0) are compiled in
    ilbc: {
      platforms: PLATFORMS,
      recipes: ['libilbc'],
      flags: ['--enable-libilbc'],
      licenses: V3,
      ships: { encoders: ['libilbc'], decoders: ['libilbc'] },
    },
    // AVS: all three of FFmpeg's class gpl; xavs only where its 2011 configure works, davs2 and xavs2 on x86-64 (with
    // their assembly) and 64-bit ARM (plain C)
    xavs: {
      platforms: ['linux-x64', 'linux-musl-x64', 'win-x64'],
      recipes: ['xavs'],
      flags: ['--enable-libxavs'],
      licenses: GPL,
      ships: { encoders: ['libxavs'] },
    },
    davs2: {
      platforms: AVS2,
      recipes: ['davs2'],
      flags: ['--enable-libdavs2'],
      licenses: GPL,
      ships: { decoders: ['libdavs2'] },
    },
    // xavs2: not Android (its thread pool calls pthread_setaffinity_np)
    xavs2: {
      platforms: AVS2.filter((p) => !p.startsWith('android-')),
      recipes: ['xavs2'],
      flags: ['--enable-libxavs2'],
      licenses: GPL,
      ships: { encoders: ['libxavs2'] },
    },
    uavs3d: {
      platforms: PLATFORMS.filter((p) => p !== 'win-arm64'),
      recipes: ['uavs3d'],
      flags: ['--enable-libuavs3d'],
      licenses: ALL,
      ships: { decoders: ['libuavs3d'] },
    },
    xeve: {
      platforms: NOT_ARMHF,
      recipes: ['xeve'],
      flags: ['--enable-libxeve'],
      licenses: ALL,
      ships: { encoders: ['libxeve'] },
    },
    xevd: {
      platforms: NOT_ARMHF,
      recipes: ['xevd'],
      flags: ['--enable-libxevd'],
      licenses: ALL,
      ships: { decoders: ['libxevd'] }, // configure's name; ffmpeg -decoders lists it as evc
    },
    oapv: {
      platforms: NOT_ARMHF,
      recipes: ['oapv'],
      flags: ['--enable-liboapv'],
      licenses: ALL,
      ships: { encoders: ['liboapv'] },
    },
    svtjpegxs: {
      platforms: PLATFORMS,
      recipes: ['svt-jpegxs'],
      flags: ['--enable-libsvtjpegxs'],
      licenses: ALL,
      ships: { encoders: ['libsvtjpegxs'], decoders: ['libsvtjpegxs'] },
    },
    // its COPYING's terms keep it out of GPL builds
    'lcevc-dec': {
      platforms: PLATFORMS.filter((p) => p !== 'win-arm64'),
      recipes: ['lcevcdec'],
      flags: ['--enable-liblcevc-dec'],
      licenses: ['lgplv2', 'lgplv3', 'nonfree'],
      ships: { filters: ['lcevc'] },
    },
    // already an option (the shipped targets have it); its decoder side is now part of what `test` checks
    openh264: {
      platforms: PLATFORMS,
      recipes: ['openh264'],
      flags: ['--enable-libopenh264'],
      licenses: ALL,
      ships: { encoders: ['libopenh264'], decoders: ['libopenh264'] },
    },
    gme: {
      platforms: PLATFORMS,
      recipes: ['libgme'],
      flags: ['--enable-libgme'],
      licenses: ALL,
      ships: { demuxers: ['libgme'] },
    },
    modplug: {
      platforms: PLATFORMS,
      recipes: ['libmodplug'],
      flags: ['--enable-libmodplug'],
      licenses: ALL,
      ships: { demuxers: ['libmodplug'] },
    },
    openmpt: {
      platforms: PLATFORMS,
      recipes: ['libopenmpt'],
      flags: ['--enable-libopenmpt'],
      licenses: ALL,
      ships: { demuxers: ['libopenmpt'] },
    },
    rav1e: {
      platforms: PLATFORMS,
      recipes: ['rav1e'],
      flags: ['--enable-librav1e'],
      licenses: ALL,
      ships: { encoders: ['librav1e'] },
    },
  };
  const CODECS = Object.keys(where);
  const text = (platform: string, license: string, option: string) =>
    `name: t\nffmpeg: 9\nplatforms: [${platform}]\nlicense: ${license}\nwith: [${option}]\n`;
  const planOn = (platform: string, license: string, option: string) => {
    const r = parseProfileText(text(platform, license, option), 't.yml');
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    return planProfile(r.profile, data, { '9': '9.0.2' });
  };
  const report = (platform: string, license: string, option: string) =>
    formatReport(checkProfile(parseProfileText(text(platform, license, option), 't.yml'), data));

  const builds = CODECS.flatMap((o) => where[o]!.platforms.map((p) => [o, p] as const));
  it.each(builds)('%s builds on %s', (option, platform) => {
    // a license that takes it (gplv3, but for LCEVC)
    const license = where[option]!.licenses.includes('gplv3') ? 'gplv3' : 'lgplv3';
    const plan = planOn(platform, license, option);
    expect(plan.errors).toEqual([]);
    const cell = plan.cells[0]!;
    expect(cell.options).toEqual([option]);
    expect([...cell.recipes].sort()).toEqual(where[option]!.recipes);
    expect(configureFlags(data, cell)).toEqual(expect.arrayContaining(where[option]!.flags));
  });

  const absent = CODECS.flatMap((o) =>
    PLATFORMS.filter((p) => !where[o]!.platforms.includes(p)).map((p) => [o, p] as const),
  );
  it.each(absent)('%s is unavailable on %s, and check says why', (option, platform) => {
    expect(planOn(platform, 'gplv3', option).cells[0]?.options ?? []).not.toContain(option);
    expect(report(platform, 'gplv3', option)).toContain(
      `not on ${platform}: the ${where[option]!.recipes.at(-1)!} recipe doesn't build there`,
    );
  });

  it.each(CODECS)('%s is refused in the licenses that may not take it', (option) => {
    for (const license of ALL.filter((l) => !where[option]!.licenses.includes(l))) {
      expect(report('linux-x64', license, option), license).toContain('✗');
    }
  });

  it('options offers each where it builds, in the licenses that allow it, with what it ships', () => {
    const facts = optionFacts(data, '9');
    for (const name of CODECS) {
      const fact = facts.find((o) => o.name === name)!;
      expect(fact.platforms, name).toEqual(where[name]!.platforms);
      expect(fact.licenses, name).toEqual(where[name]!.licenses);
    }
    for (const major of ['8', '9']) {
      for (const name of CODECS) {
        const shipped: Record<string, string[]> = {};
        for (const s of data.ffmpeg.get(major)!.options[name]!.ships ?? []) {
          (shipped[s.kind] ??= []).push(s.name);
        }
        expect(shipped, `${major} ${name}`).toEqual(where[name]!.ships);
      }
    }
  });

  it('turns on in no shipped target', () => {
    for (const c of cells) {
      // openh264 is in the shipped targets already: the new options stay off
      expect(c.options.filter((o) => CODECS.includes(o) && o !== 'openh264')).toEqual([]);
    }
  });
});

// Batch d of #21, filters and processing: each can be listed where its library builds, in the licenses its library
// (and FFmpeg's class) allow. None turns on by itself.
describe('filter and processing libraries', () => {
  const ALL = ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree'];
  const V3 = ['lgplv3', 'gplv3', 'nonfree'];
  const GPL = ['gplv2', 'gplv3', 'nonfree'];
  const ownIconv = (p: string) => /^(win|osx|ios|maccatalyst)-/.test(p);
  /** GLib and what it needs: proxy-libintl where the C library has no gettext, GNU libiconv on Apple. */
  const glibStack = (p: string) => [
    'glib',
    'libffi',
    'pcre2',
    'zlib',
    ...(p.startsWith('linux-') && !p.startsWith('linux-musl-') ? [] : ['proxy-libintl']),
    ...(/^(osx|ios|maccatalyst)-/.test(p) ? ['libiconv'] : []),
  ];
  /** cairo and what it needs: GLib, pixman, libpng, FreeType and Fontconfig on Linux and Android, FreeType on iOS. */
  const cairoStack = (p: string) => [
    ...glibStack(p),
    'cairo',
    'libpng',
    'pixman',
    ...(/^(linux|android|ios|maccatalyst)-/.test(p) ? ['freetype'] : []),
    ...(/^(linux|android)-/.test(p) ? ['fontconfig', 'libexpat'] : []),
  ];
  const where: Record<
    string,
    {
      platforms: readonly string[];
      /** the option's own recipe, which `check` names where it doesn't build */
      recipe: string;
      recipes: (platform: string) => string[];
      flags: string[];
      licenses: string[];
      ships: Record<string, string[]>;
    }
  > = {
    // FFmpeg's class gpl, and vid.stab's last release is GPL-2.0-or-later
    vidstab: {
      platforms: PLATFORMS,
      recipe: 'vid.stab',
      recipes: () => ['vid.stab'],
      flags: ['--enable-libvidstab'],
      licenses: GPL,
      ships: { filters: ['vidstabdetect', 'vidstabtransform'] },
    },
    mysofa: {
      platforms: PLATFORMS,
      recipe: 'libmysofa',
      recipes: () => ['libmysofa', 'zlib'],
      flags: ['--enable-libmysofa'],
      licenses: ALL,
      ships: { filters: ['sofalizer'] },
    },
    bs2b: {
      platforms: PLATFORMS,
      recipe: 'libbs2b',
      recipes: () => ['libbs2b'],
      flags: ['--enable-libbs2b'],
      licenses: ALL,
      ships: { filters: ['bs2b'] },
    },
    qrencode: {
      platforms: PLATFORMS,
      recipe: 'libqrencode',
      recipes: () => ['libqrencode'],
      flags: ['--enable-libqrencode'],
      licenses: ALL,
      ships: { filters: ['qrencode', 'qrencodesrc'] },
    },
    quirc: {
      platforms: PLATFORMS,
      recipe: 'quirc',
      recipes: () => ['quirc'],
      flags: ['--enable-libquirc', '--extra-libs=-lm'],
      licenses: ALL,
      ships: { filters: ['quirc'] },
    },
    flite: {
      platforms: PLATFORMS,
      recipe: 'flite',
      recipes: () => ['flite'],
      flags: ['--enable-libflite', '--extra-libs=-lm'],
      licenses: ALL,
      ships: { filters: ['flite'] },
    },
    // GPL-2.0-only files are compiled into libzvbi: gplv2 builds only (and nonfree)
    zvbi: {
      platforms: PLATFORMS,
      recipe: 'zvbi',
      recipes: (p) => (ownIconv(p) ? ['libiconv', 'zvbi'] : ['zvbi']),
      flags: ['--enable-libzvbi'],
      licenses: ['gplv2', 'nonfree'],
      ships: { decoders: ['libzvbi_teletext'] }, // configure's name; ffmpeg -decoders lists libzvbi_teletextdec
    },
    // LGPL-3.0-or-later, and FFmpeg's class version3
    aribb24: {
      platforms: PLATFORMS,
      recipe: 'aribb24',
      recipes: () => ['aribb24'],
      flags: ['--enable-libaribb24'],
      licenses: V3,
      ships: { decoders: ['libaribb24'] },
    },
    // its renderer: FreeType and Fontconfig on Linux, FreeType on Android, the system's text APIs elsewhere
    aribcaption: {
      platforms: PLATFORMS,
      recipe: 'libaribcaption',
      recipes: (p) => {
        if (p.startsWith('linux-')) {
          return ['fontconfig', 'freetype', 'libaribcaption', 'libexpat', 'libpng', 'zlib'];
        }
        return p.startsWith('android-')
          ? ['freetype', 'libaribcaption', 'libpng', 'zlib']
          : ['libaribcaption'];
      },
      flags: ['--enable-libaribcaption'],
      licenses: ALL,
      ships: { decoders: ['libaribcaption'] },
    },
    // GPL-2.0-or-later, and FFmpeg's class gpl
    rubberband: {
      platforms: PLATFORMS,
      recipe: 'rubberband',
      recipes: () => ['rubberband'],
      flags: ['--enable-librubberband'],
      licenses: GPL,
      ships: { filters: ['rubberband'] },
    },
    // plugin hosts: the header (ladspa, frei0r) or lilv's stack (lv2); the plugins come from the system at run time.
    // LADSPA needs dlopen, which Windows hasn't got
    ladspa: {
      platforms: PLATFORMS.filter((p) => !p.startsWith('win-')),
      recipe: 'ladspa-sdk',
      recipes: () => ['ladspa-sdk'],
      flags: ['--enable-ladspa'],
      licenses: ALL,
      ships: { filters: ['ladspa'] },
    },
    lv2: {
      platforms: PLATFORMS,
      recipe: 'lilv',
      recipes: () => ['lilv', 'lv2', 'serd', 'sord', 'sratom', 'zix'],
      flags: ['--enable-lv2'],
      licenses: ALL,
      ships: { filters: ['lv2'] },
    },
    frei0r: {
      platforms: PLATFORMS,
      recipe: 'frei0r',
      recipes: () => ['frei0r'],
      flags: ['--enable-frei0r'],
      licenses: GPL,
      ships: { filters: ['frei0r', 'frei0r_src'] },
    },
    // LGPL-3.0-or-later, and FFmpeg's class version3; on GLib
    lensfun: {
      platforms: PLATFORMS,
      recipe: 'lensfun',
      recipes: (p) => [...glibStack(p), 'lensfun'].sort(),
      flags: ['--enable-liblensfun'],
      licenses: V3,
      ships: { filters: ['lensfun'] },
    },
    // not iOS or Mac Catalyst (their missing macOS APIs); macOS once FFmpeg's VERSION file is out of the way (#41)
    opencolorio: {
      platforms: PLATFORMS.filter((p) => /^(linux|osx|win|android)-/.test(p)),
      recipe: 'opencolorio',
      recipes: () => [
        'imath',
        'libexpat',
        'minizip-ng',
        'opencolorio',
        'pystring',
        'yaml-cpp',
        'zlib',
      ],
      flags: ['--enable-libopencolorio'],
      licenses: ALL,
      ships: { filters: ['ocio'] },
    },
    // one cairo, with cairo-gobject (so GLib) and the platform's fonts
    cairo: {
      platforms: PLATFORMS,
      recipe: 'cairo',
      recipes: (p) => cairoStack(p).sort(),
      flags: ['--enable-cairo'],
      licenses: ALL,
      ships: { filters: ['drawvg'] },
    },
    // on cairo and Pango (not on Apple); its Apache-2.0 Rust crates keep it to v3 builds
    rsvg: {
      platforms: PLATFORMS.filter((p) => !/^(osx|ios|maccatalyst)-/.test(p)),
      recipe: 'librsvg',
      recipes: (p) =>
        [
          ...new Set([
            ...cairoStack(p),
            'freetype',
            'fribidi',
            'harfbuzz',
            'librsvg',
            'libxml2',
            'pango',
          ]),
        ].sort(),
      flags: ['--enable-librsvg'],
      licenses: V3,
      ships: { decoders: ['librsvg'] },
    },
    // Apache-2.0: v3 builds
    tesseract: {
      platforms: PLATFORMS,
      recipe: 'tesseract',
      recipes: (p) =>
        [
          'leptonica',
          'libpng',
          'tesseract',
          'zlib',
          ...(p.startsWith('android-') ? ['cpu-features'] : []),
        ].sort(),
      flags: ['--enable-libtesseract'],
      licenses: V3,
      ships: { filters: ['ocr'] },
    },
    opencv: {
      platforms: PLATFORMS,
      recipe: 'opencv',
      recipes: () => ['opencv', 'zlib'],
      flags: ['--enable-libopencv'],
      licenses: V3,
      ships: { filters: ['ocv'] },
    },
  };
  const OPTIONS = Object.keys(where);
  const text = (platform: string, license: string, option: string) =>
    `name: t\nffmpeg: 9\nplatforms: [${platform}]\nlicense: ${license}\nwith: [${option}]\n`;
  const planOn = (platform: string, license: string, option: string) => {
    const r = parseProfileText(text(platform, license, option), 't.yml');
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    return planProfile(r.profile, data, { '9': '9.0.2' });
  };
  const report = (platform: string, license: string, option: string) =>
    formatReport(checkProfile(parseProfileText(text(platform, license, option), 't.yml'), data));

  const builds = OPTIONS.flatMap((o) => where[o]!.platforms.map((p) => [o, p] as const));
  it.each(builds)('%s builds on %s', (option, platform) => {
    const plan = planOn(platform, where[option]!.licenses[0]!, option);
    expect(plan.errors).toEqual([]);
    const cell = plan.cells[0]!;
    expect(cell.options).toEqual([option]);
    expect([...cell.recipes].sort()).toEqual(where[option]!.recipes(platform));
    expect(configureFlags(data, cell)).toEqual(expect.arrayContaining(where[option]!.flags));
  });

  const absent = OPTIONS.flatMap((o) =>
    PLATFORMS.filter((p) => !where[o]!.platforms.includes(p)).map((p) => [o, p] as const),
  );
  it.each(absent)('%s is unavailable on %s, and check says why', (option, platform) => {
    expect(planOn(platform, 'nonfree', option).cells[0]?.options ?? []).not.toContain(option);
    expect(report(platform, 'nonfree', option)).toContain(
      `not on ${platform}: the ${where[option]!.recipe} recipe doesn't build there`,
    );
  });

  it.each(OPTIONS)('%s is refused in the licenses that may not take it', (option) => {
    for (const license of ALL.filter((l) => !where[option]!.licenses.includes(l))) {
      expect(report('linux-x64', license, option), license).toContain('✗');
    }
  });

  it('options offers each where it builds, in the licenses that allow it, with what it ships', () => {
    const facts = optionFacts(data, '9');
    for (const name of OPTIONS) {
      const fact = facts.find((o) => o.name === name)!;
      expect(fact.platforms, name).toEqual(where[name]!.platforms);
      expect(fact.licenses, name).toEqual(where[name]!.licenses);
    }
    for (const major of ['8', '9']) {
      for (const name of OPTIONS) {
        const shipped: Record<string, string[]> = {};
        for (const s of data.ffmpeg.get(major)!.options[name]!.ships ?? []) {
          (shipped[s.kind] ??= []).push(s.name);
        }
        expect(shipped, `${major} ${name}`).toEqual(where[name]!.ships);
      }
    }
  });

  it('brings its filters and decoders to a target that restricts them (auto-components)', () => {
    for (const major of ['8', '9']) {
      for (const name of OPTIONS) {
        expect(data.ffmpeg.get(major)!['auto-components'], `${major} ${name}`).toContain(name);
      }
    }
  });

  it('turns on in no shipped target', () => {
    for (const c of cells) {
      expect(c.options.filter((o) => OPTIONS.includes(o))).toEqual([]);
    }
  });
});

// Batch e of #21, protocols and I/O: each can be listed where its library builds, in the licenses its library (and
// FFmpeg's class) allow. None turns on by itself.
describe('protocol and I/O libraries', () => {
  const ALL = ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree'];
  const V3 = ['lgplv3', 'gplv3', 'nonfree'];
  const GPL = ['gplv2', 'gplv3', 'nonfree'];
  /** The C++ runtime FFmpeg's link takes for a C++ library it finds without pkg-config. */
  const cxxRuntime = (p: string) => {
    if (/^(osx|ios|maccatalyst|android)-/.test(p)) {
      return '-lc++';
    }
    if (p === 'win-arm64') {
      return '-l:libc++.a';
    }
    return p.startsWith('linux-musl-') ? '-l:libstdc++.a' : '-lstdc++';
  };
  const where: Record<
    string,
    {
      platforms: readonly string[];
      /** the option's own recipe, which `check` names where it doesn't build */
      recipe: string;
      recipes: (platform: string) => string[];
      flags: (platform: string) => string[];
      licenses: string[];
      ships: Record<string, string[]>;
      /** whether its components come with it to a target that restricts them (auto-components) */
      auto: boolean;
    }
  > = {
    zmq: {
      platforms: PLATFORMS,
      recipe: 'libzmq',
      recipes: () => ['libzmq'],
      flags: () => ['--enable-libzmq'],
      licenses: ALL,
      ships: { protocols: ['libzmq'], filters: ['zmq', 'azmq'] },
      auto: true,
    },
    rabbitmq: {
      platforms: PLATFORMS,
      recipe: 'rabbitmq-c',
      recipes: () => ['rabbitmq-c'],
      flags: () => ['--enable-librabbitmq'],
      licenses: ALL,
      ships: { protocols: ['libamqp'] },
      auto: true,
    },
    // a support library, as zlib is for png: a target that restricts encoders lists hap itself
    snappy: {
      platforms: PLATFORMS,
      recipe: 'snappy',
      recipes: () => ['snappy'],
      flags: (p) => ['--enable-libsnappy', `--extra-libs=${cxxRuntime(p)}`],
      licenses: ALL,
      ships: { encoders: ['hap'] },
      auto: false,
    },
    // a TLS option (FFmpeg's class version3), the one built on every platform
    mbedtls: {
      platforms: PLATFORMS,
      recipe: 'mbedtls',
      recipes: () => ['mbedtls'],
      flags: () => ['--enable-mbedtls'],
      licenses: V3,
      ships: { protocols: ['tls', 'https'] },
      auto: false,
    },
    // rtmpe's Diffie-Hellman (FFmpeg's class version3): a support library, as the TLS options are
    gmp: {
      platforms: PLATFORMS,
      recipe: 'gmp',
      recipes: () => ['gmp'],
      flags: () => ['--enable-gmp'],
      licenses: V3,
      ships: { protocols: ['rtmpe', 'rtmpte'] },
      auto: false,
    },
    // on mbedTLS (Apache-2.0 OR GPL-2.0-or-later): every build but lgplv2; not Windows, where mbedTLS isn't thread-safe
    ssh: {
      platforms: PLATFORMS.filter((p) => !p.startsWith('win-')),
      recipe: 'libssh',
      recipes: () => ['libssh', 'mbedtls'],
      flags: () => ['--enable-libssh'],
      licenses: ['lgplv3', 'gplv2', 'gplv3', 'nonfree'],
      ships: { protocols: ['libssh'] },
      auto: true,
    },
    // lgplv2 first: no GnuTLS (nettle's licence), so plain rtmp
    rtmp: {
      platforms: PLATFORMS,
      recipe: 'librtmp',
      recipes: () => ['librtmp', 'zlib'],
      flags: () => ['--enable-librtmp'],
      licenses: ALL,
      ships: { protocols: ['librtmp', 'librtmpe', 'librtmps', 'librtmpt', 'librtmpte'] },
      auto: true,
    },
    // Blu-ray: not iOS or Mac Catalyst (libbluray's Apple code wants DiskArbitration)
    bluray: {
      platforms: PLATFORMS.filter((p) => /^(linux|win|osx|android)-/.test(p)),
      recipe: 'libbluray',
      recipes: () => ['libbluray', 'libudfread', 'libxml2', 'zlib'],
      flags: () => ['--enable-libbluray'],
      licenses: ALL,
      ships: { protocols: ['bluray'] },
      auto: true,
    },
    // DVD-Video: FFmpeg's class gpl; its demuxer takes both
    dvdnav: {
      platforms: PLATFORMS,
      recipe: 'libdvdnav',
      recipes: () => ['libdvdnav', 'libdvdread'],
      flags: () => ['--enable-libdvdnav'],
      licenses: GPL,
      ships: { demuxers: ['dvdvideo'] },
      auto: true,
    },
    dvdread: {
      platforms: PLATFORMS,
      recipe: 'libdvdread',
      recipes: () => ['libdvdread'],
      flags: () => ['--enable-libdvdread'],
      licenses: GPL,
      ships: { demuxers: ['dvdvideo'] },
      auto: true,
    },
    // audio CDs, where there are drives; GPL-3.0-or-later (FFmpeg's class gpl). Its input device isn't a ships: kind.
    cdio: {
      platforms: PLATFORMS.filter((p) => /^(linux|win|osx)-/.test(p)),
      recipe: 'libcdio-paranoia',
      recipes: () => ['libcdio', 'libcdio-paranoia'],
      flags: () => ['--enable-libcdio'],
      licenses: ['gplv3', 'nonfree'],
      ships: {},
      auto: true,
    },
    // scripts, where AviSynth+ and VapourSynth run: headers only (FFmpeg loads them at run time); AviSynth+ is gpl
    avisynth: {
      platforms: PLATFORMS.filter((p) => /^(linux|win|osx)-/.test(p)),
      recipe: 'avisynth-headers',
      recipes: () => ['avisynth-headers'],
      flags: () => ['--enable-avisynth'],
      licenses: GPL,
      ships: { demuxers: ['avisynth'] },
      auto: true,
    },
    vapoursynth: {
      platforms: PLATFORMS.filter((p) => /^(linux|win|osx)-/.test(p)),
      recipe: 'vapoursynth-headers',
      recipes: () => ['vapoursynth-headers'],
      flags: () => ['--enable-vapoursynth'],
      licenses: ALL,
      ships: { demuxers: ['vapoursynth'] },
      auto: true,
    },
  };
  const OPTIONS = Object.keys(where);
  const text = (platform: string, license: string, option: string) =>
    `name: t\nffmpeg: 9\nplatforms: [${platform}]\nlicense: ${license}\nwith: [${option}]\n`;
  const planOn = (platform: string, license: string, option: string) => {
    const r = parseProfileText(text(platform, license, option), 't.yml');
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    return planProfile(r.profile, data, { '9': '9.0.2' });
  };
  const report = (platform: string, license: string, option: string) =>
    formatReport(checkProfile(parseProfileText(text(platform, license, option), 't.yml'), data));

  const builds = OPTIONS.flatMap((o) => where[o]!.platforms.map((p) => [o, p] as const));
  it.each(builds)('%s builds on %s', (option, platform) => {
    const plan = planOn(platform, where[option]!.licenses[0]!, option);
    expect(plan.errors).toEqual([]);
    const cell = plan.cells[0]!;
    expect(cell.options).toEqual([option]);
    expect([...cell.recipes].sort()).toEqual(where[option]!.recipes(platform));
    expect(configureFlags(data, cell)).toEqual(
      expect.arrayContaining(where[option]!.flags(platform)),
    );
  });

  const absent = OPTIONS.flatMap((o) =>
    PLATFORMS.filter((p) => !where[o]!.platforms.includes(p)).map((p) => [o, p] as const),
  );
  it.each(absent)('%s is unavailable on %s, and check says why', (option, platform) => {
    expect(planOn(platform, 'nonfree', option).cells[0]?.options ?? []).not.toContain(option);
    expect(report(platform, 'nonfree', option)).toContain(
      `not on ${platform}: the ${where[option]!.recipe} recipe doesn't build there`,
    );
  });

  it.each(OPTIONS)('%s is refused in the licenses that may not take it', (option) => {
    for (const license of ALL.filter((l) => !where[option]!.licenses.includes(l))) {
      expect(report('linux-x64', license, option), license).toContain('✗');
    }
  });

  it('options offers each where it builds, in the licenses that allow it, with what it ships', () => {
    const facts = optionFacts(data, '9');
    for (const name of OPTIONS) {
      const fact = facts.find((o) => o.name === name)!;
      expect(fact.platforms, name).toEqual(where[name]!.platforms);
      expect(fact.licenses, name).toEqual(where[name]!.licenses);
    }
    for (const major of ['8', '9']) {
      for (const name of OPTIONS) {
        const shipped: Record<string, string[]> = {};
        for (const s of data.ffmpeg.get(major)!.options[name]!.ships ?? []) {
          (shipped[s.kind] ??= []).push(s.name);
        }
        expect(shipped, `${major} ${name}`).toEqual(where[name]!.ships);
      }
    }
  });

  it('refuses two TLS libraries in one build: mbedtls with any other', () => {
    const both = (platform: string, license: string, other: string) =>
      formatReport(
        checkProfile(
          parseProfileText(
            `name: t\nffmpeg: 9\nplatforms: [${platform}]\nlicense: ${license}\nwith: [mbedtls, ${other}]\n`,
            't.yml',
          ),
          data,
        ),
      );
    for (const [platform, other] of [
      ['linux-x64', 'openssl'],
      ['linux-x64', 'gnutls'],
      ['win-x64', 'schannel'],
      ['osx-arm64', 'securetransport'],
    ] as const) {
      const pair = ['mbedtls', other].sort().join(' and ');
      expect(both(platform, 'gplv3', other), `${platform} ${other}`).toContain(
        `${pair} are both in this build, but FFmpeg uses one tls per build`,
      );
    }
  });

  it('encrypts rtmp with GnuTLS where the build may take it, and goes without elsewhere', () => {
    const recipesOf = (platform: string, license: string) =>
      [...planOn(platform, license, 'rtmp').cells[0]!.recipes].sort();
    const gnutls = ['gmp', 'gnutls', 'librtmp', 'libtasn1', 'nettle', 'zlib'];
    for (const platform of ['linux-x64', 'linux-musl-arm64', 'android-arm64', 'maccatalyst-x64']) {
      expect(recipesOf(platform, 'gplv2'), platform).toEqual(gnutls);
      expect(recipesOf(platform, 'lgplv3'), platform).toEqual(gnutls);
      // nettle (LGPL-3.0-or-later OR GPL-2.0-or-later) can't go into lgplv2: no GnuTLS
      expect(recipesOf(platform, 'lgplv2'), platform).toEqual(['librtmp', 'zlib']);
    }
    for (const platform of ['win-x64', 'osx-arm64', 'ios-arm64']) {
      expect(recipesOf(platform, 'gplv3'), platform).toEqual(['librtmp', 'zlib']);
    }
  });

  it('brings its protocols and filters to a target that restricts them, unless it is a support library', () => {
    for (const major of ['8', '9']) {
      for (const name of OPTIONS) {
        expect(data.ffmpeg.get(major)!['auto-components'].includes(name), `${major} ${name}`).toBe(
          where[name]!.auto,
        );
      }
    }
  });

  it('turns on in no shipped target', () => {
    for (const c of cells) {
      expect(c.options.filter((o) => OPTIONS.includes(o))).toEqual([]);
    }
  });
});

// Batch f of #21, devices: the audio input and output devices. Each can be listed where its library builds, in every
// license (their libraries are LGPL, ISC or permissive); none turns on by itself.
describe('audio device libraries', () => {
  const ALL = ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree'];
  const linuxAll = PLATFORMS.filter((p) => p.startsWith('linux-'));
  const where: Record<
    string,
    {
      platforms: readonly string[];
      recipe: string;
      recipes: (platform: string) => string[];
      flags: string[];
      /** what ships beside FFmpeg's libraries (recipe.yml's runtime:) */
      runtime: (platform: string) => string[];
    }
  > = {
    alsa: {
      platforms: linuxAll,
      recipe: 'alsa-lib',
      recipes: () => ['alsa-lib'],
      flags: ['--enable-alsa'],
      runtime: () => [],
    },
    pulse: {
      platforms: linuxAll,
      recipe: 'pulseaudio',
      recipes: () => ['libsndfile', 'pulseaudio'],
      flags: ['--enable-libpulse'],
      runtime: () => [],
    },
    jack: {
      platforms: linuxAll,
      recipe: 'jack2',
      recipes: () => ['jack2'],
      flags: ['--enable-libjack'],
      runtime: () => [],
    },
    // static, on the selected ALSA library
    sndio: {
      platforms: linuxAll,
      recipe: 'sndio',
      recipes: () => ['alsa-lib', 'sndio'],
      flags: ['--enable-sndio'],
      runtime: () => [],
    },
    // static; on Linux linked to the selected ALSA library; not linux-armhf,
    // whose CMake is older than OpenAL Soft's CMakeLists.txt needs
    openal: {
      platforms: PLATFORMS.filter((p) => /^(linux|win|osx)-/.test(p) && p !== 'linux-armhf'),
      recipe: 'openal-soft',
      recipes: (p) => (p.startsWith('linux-') ? ['alsa-lib', 'openal-soft'] : ['openal-soft']),
      flags: ['--enable-openal'],
      runtime: () => [],
    },
  };
  const OPTIONS = Object.keys(where);
  const text = (platform: string, license: string, option: string) =>
    `name: t\nffmpeg: 9\nplatforms: [${platform}]\nlicense: ${license}\nwith: [${option}]\n`;
  const profileOf = (platform: string, license: string, option: string) => {
    const r = parseProfileText(text(platform, license, option), 't.yml');
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    return r.profile;
  };
  const planOn = (platform: string, license: string, option: string) =>
    planProfile(profileOf(platform, license, option), data, { '9': '9.0.2' });
  const report = (platform: string, license: string, option: string) =>
    formatReport(checkProfile(parseProfileText(text(platform, license, option), 't.yml'), data));
  const runtimeOf = (platform: string, option: string) => {
    const cell = planOn(platform, 'lgplv2', option).cells[0]!;
    return makeBuildPlan({
      profile: profileOf(platform, 'lgplv2', option),
      data,
      locked: {
        ffmpeg: { '9': '9.0.2' },
        libraries: Object.fromEntries(cell.recipes.map((r) => [r, '1.0.0'])),
        pinned: [],
      },
      cell,
      variant: 'lgplv2',
      imageId: 'x',
      cacheDir: mkdtempSync(join(tmpdir(), 'c-')),
    }).runtime;
  };

  const builds = OPTIONS.flatMap((o) => where[o]!.platforms.map((p) => [o, p] as const));
  it.each(builds)('%s builds on %s, in every license', (option, platform) => {
    for (const license of ALL) {
      const plan = planOn(platform, license, option);
      expect(plan.errors, license).toEqual([]);
      const cell = plan.cells[0]!;
      expect(cell.options).toEqual([option]);
      expect([...cell.recipes].sort()).toEqual(where[option]!.recipes(platform));
      expect(configureFlags(data, cell)).toEqual(expect.arrayContaining(where[option]!.flags));
    }
  });

  it.each(builds)('%s on %s ships what it links shared beside FFmpeg', (option, platform) => {
    expect(runtimeOf(platform, option).sort()).toEqual(where[option]!.runtime(platform));
  });

  const absent = OPTIONS.flatMap((o) =>
    PLATFORMS.filter((p) => !where[o]!.platforms.includes(p)).map((p) => [o, p] as const),
  );
  it.each(absent)('%s is unavailable on %s, and check says why', (option, platform) => {
    expect(planOn(platform, 'nonfree', option).cells[0]?.options ?? []).not.toContain(option);
    expect(report(platform, 'nonfree', option)).toContain(`not on ${platform}:`);
  });

  it('options offers each where it builds, in every license; devices are no ships: kind', () => {
    const facts = optionFacts(data, '9');
    for (const name of OPTIONS) {
      const fact = facts.find((o) => o.name === name)!;
      expect(fact.platforms, name).toEqual(where[name]!.platforms);
      expect(fact.licenses, name).toEqual(ALL);
    }
    for (const major of ['8', '9']) {
      for (const name of OPTIONS) {
        expect(data.ffmpeg.get(major)!.options[name]!.ships ?? [], `${major} ${name}`).toEqual([]);
      }
    }
  });

  it('brings its devices to a target that restricts them (auto-components)', () => {
    for (const major of ['8', '9']) {
      for (const name of OPTIONS) {
        expect(data.ffmpeg.get(major)!['auto-components'], `${major} ${name}`).toContain(name);
      }
    }
  });

  it('turns on in no shipped target', () => {
    for (const c of cells) {
      expect(c.options.filter((o) => OPTIONS.includes(o))).toEqual([]);
    }
  });
});

// Batch f of #21, devices: X11's (x11grab, the xv output device) and the terminal's (caca), all static, on Linux, in
// every license; none turns on by itself.
describe('X11 and terminal device libraries', () => {
  const ALL = ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree'];
  const linuxAll = PLATFORMS.filter((p) => p.startsWith('linux-'));
  const xcb = ['libxau', 'libxcb', 'xcb-proto', 'xorgproto'];
  const where: Record<string, { recipes: string[]; flags: string[] }> = {
    xcb: {
      recipes: xcb,
      flags: [
        '--enable-libxcb',
        '--enable-libxcb-shm',
        '--enable-libxcb-shape',
        '--enable-libxcb-xfixes',
      ],
    },
    xlib: {
      recipes: [...xcb, 'libx11', 'libxext', 'libxv', 'xtrans'].sort(),
      flags: ['--enable-xlib'],
    },
    caca: { recipes: ['libcaca', 'ncurses', 'zlib'], flags: ['--enable-libcaca'] },
  };
  const OPTIONS = Object.keys(where);
  const text = (platform: string, license: string, option: string) =>
    `name: t\nffmpeg: 9\nplatforms: [${platform}]\nlicense: ${license}\nwith: [${option}]\n`;
  const planOn = (platform: string, license: string, option: string) => {
    const r = parseProfileText(text(platform, license, option), 't.yml');
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    return planProfile(r.profile, data, { '9': '9.0.2' });
  };
  const report = (platform: string, license: string, option: string) =>
    formatReport(checkProfile(parseProfileText(text(platform, license, option), 't.yml'), data));

  const builds = OPTIONS.flatMap((o) => linuxAll.map((p) => [o, p] as const));
  it.each(builds)(
    '%s builds on %s, in every license, shipping nothing beside FFmpeg',
    (option, platform) => {
      for (const license of ALL) {
        const plan = planOn(platform, license, option);
        expect(plan.errors, license).toEqual([]);
        const cell = plan.cells[0]!;
        expect(cell.options).toEqual([option]);
        expect([...cell.recipes].sort()).toEqual(where[option]!.recipes);
        expect(configureFlags(data, cell)).toEqual(expect.arrayContaining(where[option]!.flags));
      }
      for (const r of where[option]!.recipes) {
        expect(data.recipes.get(r)!.runtime ?? [], r).toEqual([]);
      }
    },
  );

  const absent = OPTIONS.flatMap((o) =>
    PLATFORMS.filter((p) => !linuxAll.includes(p)).map((p) => [o, p] as const),
  );
  it.each(absent)('%s is unavailable on %s, and check says why', (option, platform) => {
    expect(planOn(platform, 'nonfree', option).cells[0]?.options ?? []).not.toContain(option);
    expect(report(platform, 'nonfree', option)).toContain(`not on ${platform}:`);
  });

  it('options offers each on Linux, in every license; devices are no ships: kind', () => {
    const facts = optionFacts(data, '9');
    for (const name of OPTIONS) {
      const fact = facts.find((o) => o.name === name)!;
      expect(fact.platforms, name).toEqual(linuxAll);
      expect(fact.licenses, name).toEqual(ALL);
    }
    for (const major of ['8', '9']) {
      for (const name of OPTIONS) {
        expect(data.ffmpeg.get(major)!.options[name]!.ships ?? [], `${major} ${name}`).toEqual([]);
        expect(data.ffmpeg.get(major)!['auto-components'], `${major} ${name}`).toContain(name);
      }
    }
  });

  it('leaves vdpau headers-only, with xlib or without', () => {
    const plan = planOn('linux-x64', 'lgplv2', 'vdpau, xlib');
    expect(plan.cells[0]!.recipes).toContain('libvdpau');
    expect(data.recipes.get('libvdpau')!.needs).toEqual([]);
  });

  it('turns on in no shipped target', () => {
    for (const c of cells) {
      expect(c.options.filter((o) => OPTIONS.includes(o))).toEqual([]);
    }
  });
});

// Batch f of #21, devices: capture (libv4l2 for the v4l2 input device; FireWire cameras and camcorders), static, on
// Linux, in every license; none turns on by itself.
describe('capture device libraries', () => {
  const ALL = ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree'];
  const linuxAll = PLATFORMS.filter((p) => p.startsWith('linux-'));
  const where: Record<string, { recipes: string[]; flags: string[]; auto: boolean }> = {
    // the v4l2 input device is built without it too: no component needs it
    v4l2: { recipes: ['v4l-utils'], flags: ['--enable-libv4l2'], auto: false },
    dc1394: { recipes: ['libdc1394', 'libraw1394'], flags: ['--enable-libdc1394'], auto: true },
    iec61883: {
      recipes: ['libavc1394', 'libiec61883', 'libraw1394'],
      flags: ['--enable-libiec61883', '--extra-libs=-lavc1394 -lrom1394 -lraw1394'],
      auto: true,
    },
  };
  const OPTIONS = Object.keys(where);
  const text = (platform: string, license: string, option: string) =>
    `name: t\nffmpeg: 9\nplatforms: [${platform}]\nlicense: ${license}\nwith: [${option}]\n`;
  const planOn = (platform: string, license: string, option: string) => {
    const r = parseProfileText(text(platform, license, option), 't.yml');
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    return planProfile(r.profile, data, { '9': '9.0.2' });
  };
  const report = (platform: string, license: string, option: string) =>
    formatReport(checkProfile(parseProfileText(text(platform, license, option), 't.yml'), data));

  const builds = OPTIONS.flatMap((o) => linuxAll.map((p) => [o, p] as const));
  it.each(builds)('%s builds on %s, in every license', (option, platform) => {
    for (const license of ALL) {
      const plan = planOn(platform, license, option);
      expect(plan.errors, license).toEqual([]);
      const cell = plan.cells[0]!;
      expect(cell.options).toEqual([option]);
      expect([...cell.recipes].sort()).toEqual(where[option]!.recipes);
      expect(configureFlags(data, cell)).toEqual(expect.arrayContaining(where[option]!.flags));
    }
  });

  const absent = OPTIONS.flatMap((o) =>
    PLATFORMS.filter((p) => !linuxAll.includes(p)).map((p) => [o, p] as const),
  );
  it.each(absent)('%s is unavailable on %s, and check says why', (option, platform) => {
    expect(planOn(platform, 'nonfree', option).cells[0]?.options ?? []).not.toContain(option);
    expect(report(platform, 'nonfree', option)).toContain(`not on ${platform}:`);
  });

  it('options offers each on Linux, in every license; devices are no ships: kind', () => {
    const facts = optionFacts(data, '9');
    for (const name of OPTIONS) {
      const fact = facts.find((o) => o.name === name)!;
      expect(fact.platforms, name).toEqual(linuxAll);
      expect(fact.licenses, name).toEqual(ALL);
    }
    for (const major of ['8', '9']) {
      for (const name of OPTIONS) {
        expect(data.ffmpeg.get(major)!.options[name]!.ships ?? [], `${major} ${name}`).toEqual([]);
        expect(data.ffmpeg.get(major)!['auto-components'].includes(name), `${major} ${name}`).toBe(
          where[name]!.auto,
        );
      }
    }
  });

  it('turns on in no shipped target', () => {
    for (const c of cells) {
      expect(c.options.filter((o) => OPTIONS.includes(o))).toEqual([]);
    }
  });
});

// Batch f of #21, devices: Apple's capture device (AVFoundation) and the macOS framework behind the coreimage filters,
// built in (the OS provides them). Nothing to build or license; none turns on by itself.
describe("Apple's capture device and Core Image", () => {
  const ALL = ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree'];
  const apple = PLATFORMS.filter((p) => /^(osx|ios|maccatalyst)-/.test(p));
  const macos = PLATFORMS.filter((p) => p.startsWith('osx-'));
  const where: Record<
    string,
    { platforms: string[]; flags: string[]; ships: Record<string, string[]> }
  > = {
    // the avfoundation input device: cameras and microphones, and on macOS screens
    avfoundation: { platforms: apple, flags: ['--enable-avfoundation'], ships: {} },
    // the coreimage and coreimagesrc filters, which need AppKit too (appkit turns nothing else on)
    coreimage: {
      platforms: macos,
      flags: ['--enable-coreimage', '--enable-appkit'],
      ships: { filters: ['coreimage', 'coreimagesrc'] },
    },
    metal: {
      platforms: macos,
      flags: ['--enable-metal', '--enable-videotoolbox'],
      ships: {
        filters: ['yadif_videotoolbox'],
        hwaccels: ['videotoolbox'],
        encoders: ['h264_videotoolbox', 'hevc_videotoolbox'],
      },
    },
  };
  const OPTIONS = Object.keys(where);
  const text = (platform: string, license: string, options: string) =>
    `name: t\nffmpeg: 9\nplatforms: [${platform}]\nlicense: ${license}\nwith: [${options}]\n`;
  const planOn = (platform: string, license: string, options: string) => {
    const r = parseProfileText(text(platform, license, options), 't.yml');
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    return planProfile(r.profile, data, { '9': '9.0.2' });
  };
  const report = (platform: string, license: string, option: string) =>
    formatReport(checkProfile(parseProfileText(text(platform, license, option), 't.yml'), data));

  const builds = OPTIONS.flatMap((o) => where[o]!.platforms.map((p) => [o, p] as const));
  it.each(builds)('%s is built in on %s, in every license', (option, platform) => {
    for (const license of ALL) {
      const plan = planOn(platform, license, option);
      expect(plan.errors, license).toEqual([]);
      const cell = plan.cells[0]!;
      expect(cell.options).toEqual([option]);
      expect([...cell.recipes]).toEqual([]);
      expect(configureFlags(data, cell)).toEqual(expect.arrayContaining(where[option]!.flags));
    }
  });

  const absent = OPTIONS.flatMap((o) =>
    PLATFORMS.filter((p) => !where[o]!.platforms.includes(p)).map((p) => [o, p] as const),
  );
  it.each(absent)('%s is unavailable on %s, and check says why', (option, platform) => {
    expect(planOn(platform, 'nonfree', option).cells[0]?.options ?? []).not.toContain(option);
    expect(report(platform, 'nonfree', option)).toContain(
      `not on ${platform}: FFmpeg doesn't support ${option} there`,
    );
  });

  it('options offers each where it is built in, in every license, with what it ships', () => {
    const facts = optionFacts(data, '9');
    for (const name of OPTIONS) {
      const fact = facts.find((o) => o.name === name)!;
      expect(fact.platforms, name).toEqual(where[name]!.platforms);
      expect(fact.licenses, name).toEqual(ALL);
    }
    for (const major of ['8', '9']) {
      for (const name of OPTIONS) {
        const shipped: Record<string, string[]> = {};
        for (const s of data.ffmpeg.get(major)!.options[name]!.ships ?? []) {
          (shipped[s.kind] ??= []).push(s.name);
        }
        expect(shipped, `${major} ${name}`).toEqual(where[name]!.ships);
      }
    }
  });

  it('turns on AppKit with coreimage, which its filters need too, and nothing else', () => {
    const flags = (option: string) =>
      configureFlags(data, planOn('osx-arm64', 'lgplv2', option).cells[0]!);
    expect(flags('coreimage')).toContain('--enable-appkit');
    expect(flags('avfoundation').filter((f) => /appkit|coreimage/.test(f))).toEqual([]);
  });

  it('enables Metal only on macOS, with its upstream ownership fix applied during the build', () => {
    for (const major of ['8', '9']) {
      expect(data.ffmpeg.get(major)!.options['metal']!.builtin).toBe(true);
      expect(data.ffmpeg.get(major)!['auto-components']).toContain('metal');
    }
  });

  it('brings its device and filters to a target that restricts them (auto-components)', () => {
    for (const major of ['8', '9']) {
      for (const name of OPTIONS) {
        expect(data.ffmpeg.get(major)!['auto-components'], `${major} ${name}`).toContain(name);
      }
    }
  });

  it('turns on in no shipped target', () => {
    for (const c of cells) {
      expect(c.options.filter((o) => OPTIONS.includes(o))).toEqual([]);
    }
  });
});
