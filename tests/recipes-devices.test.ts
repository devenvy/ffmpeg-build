// Batch f of #21 (devices): each library's build on every platform it builds on, with the process runner stubbed,
// and the files it leaves in deps.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  build,
  cmakeLines,
  commands,
  configureLine,
  type Harness,
  harness,
  pcPath,
  platformsOf,
  recipe,
} from './recipe-harness.ts';
import { PLATFORMS } from '../src/platforms.ts';

import type * as RunModule from '../src/build/run.ts';

vi.mock('../src/build/run.ts', async (original) => ({
  ...(await original<typeof RunModule>()),
  run: vi.fn(),
}));

let made: Harness[] = [];
afterEach(() => {
  for (const h of made) {
    rmSync(h.root, { recursive: true, force: true });
  }
  made = [];
});
function fake(platform: string): Harness {
  const h = harness(platform);
  made.push(h);
  return h;
}
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};
const LINUX = PLATFORMS.filter((p) => p.startsWith('linux-'));
/** The C++ runtime a static link needs, as the engine's {cxx-runtime} names it. */
const cxxRuntime = (platform: string) => {
  if (/^(osx|ios|maccatalyst|android)-/.test(platform)) {
    return '-lc++';
  }
  if (platform === 'win-arm64') {
    return '-l:libc++.a';
  }
  return platform.startsWith('linux-musl-') ? '-l:libstdc++.a' : '-lstdc++';
};

/** What a shipped library's link takes on musl: glibc's 8 MiB thread stacks (and, for C++, static runtimes). */
const muslLdflags = (platform: string, extra = '') =>
  platform.startsWith('linux-musl-') ? `LDFLAGS= -Wl,-z,stack-size=8388608${extra}` : '';
/** A command line as `commands` shows it, with the environment it ran with. */
const withEnv = (line: string, ...env: string[]) =>
  env.some(Boolean) ? `${line} [${env.filter(Boolean).join(' ')}]` : line;

// ALSA, PulseAudio and JACK: shared client libraries, shipped beside FFmpeg under the system's sonames
describe('alsa-lib', () => {
  // the distributions' plugin folders for the platform, Debian's multiarch one first
  const plugindirs: Record<string, string> = {
    'linux-x64': '/usr/lib/x86_64-linux-gnu/alsa-lib:/usr/lib64/alsa-lib:/usr/lib/alsa-lib',
    'linux-musl-x64': '/usr/lib/x86_64-linux-gnu/alsa-lib:/usr/lib64/alsa-lib:/usr/lib/alsa-lib',
    'linux-arm64': '/usr/lib/aarch64-linux-gnu/alsa-lib:/usr/lib64/alsa-lib:/usr/lib/alsa-lib',
    'linux-musl-arm64': '/usr/lib/aarch64-linux-gnu/alsa-lib:/usr/lib64/alsa-lib:/usr/lib/alsa-lib',
    'linux-armhf': '/usr/lib/arm-linux-gnueabihf/alsa-lib:/usr/lib/alsa-lib',
  };
  it.each(platformsOf('alsa-lib'))('%s', async (platform) => {
    const h = fake(platform);
    const dlmisc = join(h.src, 'src', 'dlmisc.c');
    put(
      dlmisc,
      '\tsnprintf(path, path_len, "%s/%s",\n\t\t snd_plugin_dir ? snd_plugin_dir : ALSA_PLUGIN_DIR, name);\n',
    );
    const topology = pcPath(h, 'alsa-topology');
    h.onRun = (call) => {
      if (call.args.includes('install-pkgconfigDATA')) {
        put(topology, 'Name: alsa-topology\n');
      }
      return undefined;
    };
    await build(h, 'alsa-lib');
    // the library, its headers and alsa.pc only: the configuration is the system's
    expect(commands(h)).toEqual(
      [
        configureLine(h, [
          '--enable-shared',
          '--disable-static',
          '--disable-python',
          '--disable-topology',
          '--disable-aload',
          '--with-configdir=/usr/share/alsa',
          `--with-plugindir=${plugindirs[platform]!}`,
        ]),
        'make -j4 -C src',
        'make -C src install-libLTLIBRARIES',
        'make -C include install',
        'make -C utils install-pkgconfigDATA',
      ].map((line) => withEnv(line, muslLdflags(platform))),
    );
    expect(existsSync(topology)).toBe(false);
    // ALSA_PLUGIN_DIR read as a list: the first folder that has the plugin
    const patched = h.read(dlmisc);
    expect(patched).toContain("end = strchr(dir, ':');");
    expect(patched).toContain('if (access(path, F_OK) == 0)');
    expect(patched).not.toContain('snd_plugin_dir ? snd_plugin_dir : ALSA_PLUGIN_DIR');
  });
  it('is LGPL-2.1-or-later, on Linux, shipped as libasound.so.2', () => {
    expect(recipe('alsa-lib').license).toBe('LGPL-2.1-or-later');
    expect(platformsOf('alsa-lib')).toEqual(LINUX);
    expect(recipe('alsa-lib').runtime).toEqual([{ value: 'lib/libasound.so*' }]);
  });
});

describe('pulseaudio', () => {
  it.each(platformsOf('pulseaudio'))('%s', async (platform) => {
    const h = fake(platform);
    const meson = join(h.src, 'meson.build');
    put(meson, "cdata.set('ENABLE_NLS', 1)\n");
    await build(h, 'pulseaudio');
    // no translations, so no <libintl.h> (musl has none)
    expect(h.read(meson)).toBe('\n');
    expect(commands(h)).toEqual(
      [
        [
          'meson setup _build .',
          `--prefix=${h.deps}`,
          '--libdir=lib --buildtype=release --sysconfdir=/etc --localedir=/usr/share/locale',
          ...h.context.toolchain.mesonArgs,
          '-Dauto_features=disabled -Ddaemon=false -Dclient=true -Ddoxygen=false -Dman=false -Dtests=false',
          '-Dbashcompletiondir=no -Dzshcompletiondir=no',
        ].join(' '),
        'meson compile -C _build',
        'meson install -C _build --tags runtime,devel',
      ].map((line) => withEnv(line, muslLdflags(platform))),
    );
  });
  it('is the client library alone, on libsndfile, shipped with its libpulsecommon', () => {
    expect(recipe('pulseaudio').license).toBe('LGPL-2.1-or-later');
    expect(recipe('pulseaudio').needs).toEqual([{ name: 'libsndfile' }]);
    expect(platformsOf('pulseaudio')).toEqual(LINUX);
    expect(recipe('pulseaudio').runtime).toEqual([
      { value: 'lib/libpulse.so*' },
      { value: 'lib/pulseaudio/libpulsecommon-*.so' },
    ]);
  });
});

describe('libsndfile', () => {
  it.each(platformsOf('libsndfile'))('%s', async (platform) => {
    const h = fake(platform);
    await build(h, 'libsndfile');
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DENABLE_EXTERNAL_LIBS=OFF',
        '-DENABLE_MPEG=OFF',
        '-DBUILD_PROGRAMS=OFF',
        '-DBUILD_EXAMPLES=OFF',
        '-DBUILD_TESTING=OFF',
        '-DENABLE_CPACK=OFF',
        '-DENABLE_PACKAGE_CONFIG=OFF',
      ]),
    );
  });
  it('builds where PulseAudio does', () => {
    expect(platformsOf('libsndfile')).toEqual(platformsOf('pulseaudio'));
  });
});

describe('jack2', () => {
  it.each(platformsOf('jack2'))('%s', async (platform) => {
    const h = fake(platform);
    const context = join(h.src, 'waflib', 'Context.py');
    put(context, 'import os, re, imp, sys\n\tmodule = imp.new_module(WSCRIPT_FILE)\n');
    await build(h, 'jack2');
    // Python 3.12 has no imp
    expect(h.read(context)).toBe(
      'import os, re, sys, types\n\tmodule = types.ModuleType(WSCRIPT_FILE)\n',
    );
    const cross = platform === 'linux-armhf' ? 'arm-linux-gnueabihf-' : '';
    const musl = muslLdflags(platform, ' -static-libstdc++ -static-libgcc');
    expect(commands(h)).toEqual([
      withEnv(
        [
          'python3 ./waf configure',
          `--prefix=${h.deps} --libdir=${h.deps}/lib`,
          '--autostart=none --alsa=no --firewire=no --iio=no --portaudio=no --winmme=no --celt=no --opus=no',
          '--samplerate=no --systemd=no --db=no --doxygen=no',
        ].join(' '),
        `CC=${cross}gcc`,
        `CXX=${cross}g++`,
        musl,
      ),
      withEnv('python3 ./waf build -j4', musl),
      withEnv('python3 ./waf install', musl),
    ]);
  });
  it('ships libjack (LGPL-2.1-or-later) on Linux', () => {
    expect(recipe('jack2').license).toBe('LGPL-2.1-or-later');
    expect(platformsOf('jack2')).toEqual(LINUX);
    expect(recipe('jack2').runtime).toEqual([{ value: 'lib/libjack.so*' }]);
  });
});

// sndio and OpenAL Soft: static
describe('sndio', () => {
  it.each(platformsOf('sndio'))('%s', async (platform) => {
    const h = fake(platform);
    const pc = pcPath(h, 'sndio');
    h.onRun = (call) => {
      if (call.command === 'make') {
        put(join(h.src, 'libsndio', 'sndio.pc'), 'Name: sndio\nLibs: -lsndio\n');
        put(join(h.src, 'libsndio', 'sndio.h'), '');
        put(join(h.src, 'libsndio', 'libsndio.a'), '');
      }
      return undefined;
    };
    await build(h, 'sndio');
    const cross = platform === 'linux-armhf' ? 'arm-linux-gnueabihf-' : '';
    expect(commands(h)).toEqual([
      [
        `./configure --prefix=${h.deps} --enable-static --enable-alsa --without-libbsd`,
        `CC=${cross}gcc AR=${cross}ar CFLAGS=-O2 -fPIC -I${h.deps}/include`,
      ].join(' '),
      'make -j4 -C libsndio',
    ]);
    expect(existsSync(join(h.deps, 'include', 'sndio.h'))).toBe(true);
    expect(existsSync(join(h.deps, 'lib', 'libsndio.a'))).toBe(true);
    // its .pc names no private libraries: ALSA's, librt and libm
    expect(h.read(pc)).toContain('Requires.private: alsa');
    expect(h.read(pc)).toContain('Libs.private: -lrt -lm');
  });
  it('is ISC, on ALSA, on Linux', () => {
    expect(recipe('sndio').license).toBe('ISC');
    expect(recipe('sndio').needs).toEqual([{ name: 'alsa-lib' }]);
    expect(platformsOf('sndio')).toEqual(LINUX);
  });
});

describe('openal-soft', () => {
  it.each(platformsOf('openal-soft'))('%s', async (platform) => {
    const h = fake(platform);
    const pc = pcPath(h, 'openal');
    const alc = join(h.src, 'alc', 'alc.cpp');
    put(alc, '| std::views::transform(&ContextBase::EffectSlotCluster::operator*)\n');
    h.onRun = (call) => {
      if (call.command === 'cmake' && call.args[0] === '--install') {
        put(pc, 'Name: OpenAL\nLibs: -lopenal\nLibs.private: -lm\n');
      }
      return undefined;
    };
    await build(h, 'openal-soft');
    expect(commands(h)).toEqual(
      cmakeLines(h, [
        '-DLIBTYPE=STATIC',
        '-DALSOFT_UTILS=OFF',
        '-DALSOFT_EXAMPLES=OFF',
        '-DALSOFT_TESTS=OFF',
        '-DALSOFT_INSTALL_CONFIG=OFF',
        '-DALSOFT_INSTALL_HRTF_DATA=OFF',
        '-DALSOFT_INSTALL_AMBDEC_PRESETS=OFF',
        '-DALSOFT_INSTALL_EXAMPLES=OFF',
        '-DALSOFT_INSTALL_UTILS=OFF',
        '-DALSOFT_UPDATE_BUILD_VERSION=OFF',
        '-DALSOFT_ENABLE_MODULES=OFF',
        '-DALSOFT_BACKEND_PIPEWIRE=OFF',
        '-DALSOFT_BACKEND_PULSEAUDIO=OFF',
        '-DALSOFT_BACKEND_JACK=OFF',
        '-DALSOFT_BACKEND_SNDIO=OFF',
        '-DALSOFT_BACKEND_PORTAUDIO=OFF',
        '-DALSOFT_BACKEND_SDL2=OFF',
        '-DALSOFT_BACKEND_SDL3=OFF',
        ...(platform.startsWith('linux-') ? ['-DALSOFT_REQUIRE_ALSA=ON'] : []),
      ]),
    );
    expect(h.read(pc)).toContain(`Libs.private: -lm ${cxxRuntime(platform)}`);
    // a lambda for the member pointer newer libc++ can't deduce in views::transform
    expect(h.read(alc)).toBe(
      '| std::views::transform([](auto &cluster) -> auto& { return *cluster; })\n',
    );
    // Windows: COM's and the known folders' libraries, which its .pc leaves out
    expect(h.read(pc).includes('-lole32 -lshell32 -luuid')).toBe(platform.startsWith('win-'));
  });
  it('builds on Linux (with ALSA; not armhf, whose CMake is too old), Windows and macOS', () => {
    expect(platformsOf('openal-soft')).toEqual(
      PLATFORMS.filter((p) => /^(linux|win|osx)-/.test(p) && p !== 'linux-armhf'),
    );
    expect(recipe('openal-soft').needs).toEqual([{ name: 'alsa-lib', platforms: ['linux-*'] }]);
    expect(recipe('openal-soft').license).toBe(
      'LGPL-2.0-or-later AND BSD-3-Clause AND LicenseRef-pffft AND MIT',
    );
  });
});
