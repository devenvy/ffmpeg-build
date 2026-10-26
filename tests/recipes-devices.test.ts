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

// ALSA defaults to static builtin plugins; PulseAudio and JACK retain shared client libraries.
describe('alsa-lib', () => {
  // Upstream uses one plugin directory, with ALSA_PLUGIN_DIR as the recipient's native override.
  const plugindirs: Record<string, string> = {
    'linux-x64': '/usr/lib/x86_64-linux-gnu/alsa-lib',
    'linux-musl-x64': '/usr/lib/alsa-lib',
    'linux-arm64': '/usr/lib/aarch64-linux-gnu/alsa-lib',
    'linux-musl-arm64': '/usr/lib/alsa-lib',
    'linux-armhf': '/usr/lib/arm-linux-gnueabihf/alsa-lib',
  };
  it.each(platformsOf('alsa-lib'))('%s', async (platform) => {
    const h = fake(platform);
    expect(h.base['CFLAGS']).toContain('-fPIC');
    const dlmisc = join(h.src, 'src', 'dlmisc.c');
    const original =
      '\tsnprintf(path, path_len, "%s/%s",\n\t\t snd_plugin_dir ? snd_plugin_dir : ALSA_PLUGIN_DIR, name);\n' +
      '#ifndef PIC\n\tif (name == NULL)\n\t\treturn &snd_dlsym_start;\n#else\n';
    put(dlmisc, original);
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
          '--disable-shared',
          '--enable-static',
          '--without-libdl',
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
    expect(h.read(dlmisc)).toBe(original);
  });
  it('is LGPL-2.1-or-later, on Linux, with an opt-in shared runtime', () => {
    expect(recipe('alsa-lib').license).toBe('LGPL-2.1-or-later');
    expect(platformsOf('alsa-lib')).toEqual(LINUX);
    expect(recipe('alsa-lib').linkage!.modes.shared!.runtime).toEqual([
      { value: 'lib/libasound.so*' },
    ]);
  });
});

describe('pulseaudio', () => {
  it.each(platformsOf('pulseaudio'))('%s', async (platform) => {
    const h = fake(platform);
    const meson = join(h.src, 'meson.build');
    put(meson, "cdata.set('ENABLE_NLS', 1)\n");
    const common = join(h.src, 'src', 'meson.build');
    const client = join(h.src, 'src', 'pulse', 'meson.build');
    put(common, "libpulsecommon = shared_library('pulsecommon-' + pa_version_major_minor,\n");
    put(
      client,
      "libpulse = shared_library('pulse',\nlibpulse_simple = shared_library('pulse-simple',\nlibpulse_mainloop_glib = shared_library('pulse-mainloop-glib',\n",
    );
    const pc = pcPath(h, 'libpulse');
    h.onRun = (call) => {
      if (call.command === 'meson' && call.args[0] === 'install') {
        put(pc, `Name: libpulse\nLibs.private: -L\${libdir}/pulseaudio -lpulsecommon-1.2\n`);
      }
      return undefined;
    };
    await build(h, 'pulseaudio');
    expect(h.read(common)).toBe(
      "libpulsecommon = shared_library('pulsecommon-' + pa_version_major_minor,\n",
    );
    expect(h.read(client)).toBe(
      "libpulse = shared_library('pulse',\nlibpulse_simple = shared_library('pulse-simple',\nlibpulse_mainloop_glib = shared_library('pulse-mainloop-glib',\n",
    );
    expect(h.read(pc)).toContain('-lpulsecommon-1.2 -lm -ldl -lrt');
    expect(h.read(pc)).toContain('Requires.private: sndfile');
    expect(h.read(meson)).toBe("cdata.set('ENABLE_NLS', 1)\n");
    expect(commands(h)).toEqual(
      [
        [
          'meson setup _build .',
          `--prefix=${h.deps}`,
          '--libdir=lib --buildtype=release --default-library=shared -Db_staticpic=true --sysconfdir=/etc --localedir=/usr/share/locale',
          ...h.context.toolchain.mesonArgs,
          '-Dauto_features=disabled -Ddaemon=false -Dclient=true -Ddoxygen=false -Dman=false -Dtests=false',
          '-Dbashcompletiondir=no -Dzshcompletiondir=no',
        ].join(' '),
        'meson compile -C _build',
        'meson install -C _build --tags runtime,devel',
      ].map((line) =>
        withEnv(
          line,
          platform.startsWith('linux-musl-') ? `CPPFLAGS= -I${h.deps}/include` : '',
          platform.startsWith('linux-musl-')
            ? `LDFLAGS= -L${h.deps}/lib -Wl,-z,stack-size=8388608`
            : '',
        ),
      ),
    );
  });
  it('is the client library alone, on libsndfile, shipped with its libpulsecommon', () => {
    expect(recipe('pulseaudio').license).toBe('LGPL-2.1-or-later');
    expect(recipe('pulseaudio').needs).toEqual([{ name: 'libsndfile' }]);
    expect(platformsOf('pulseaudio')).toEqual(LINUX);
    expect(recipe('pulseaudio').linkage!.modes.shared!.runtime).toEqual([
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
    expect(platformsOf('libsndfile')).toEqual(PLATFORMS);
  });
});

describe('jack2', () => {
  it.each(
    platformsOf('jack2').flatMap((platform) =>
      ['python3', '/opt/python/cp311-cp311/bin/python3.11'].map(
        (python) => [platform, python] as const,
      ),
    ),
  )('%s with %s', async (platform, python) => {
    const h = harness(platform, { env: { JACK_PYTHON: python } });
    made.push(h);
    const context = join(h.src, 'waflib', 'Context.py');
    put(context, 'import os, re, imp, sys\n\tmodule = imp.new_module(WSCRIPT_FILE)\n');
    const common = join(h.src, 'common', 'wscript');
    put(common, "clientlib = bld(features=['c', 'cxx', 'cxxshlib', 'cshlib'])\n");
    const pc = pcPath(h, 'jack');
    h.onRun = (call) => {
      if (call.args.includes('install')) {
        put(pc, 'Name: jack\nLibs: -ljack\n');
      }
      return undefined;
    };
    await build(h, 'jack2');
    expect(h.read(common)).toBe("clientlib = bld(features=['c', 'cxx', 'cxxshlib', 'cshlib'])\n");
    expect(h.read(pc)).toBe('Name: jack\nLibs: -ljack\n');
    expect(h.read(context)).toBe(
      'import os, re, imp, sys\n\tmodule = imp.new_module(WSCRIPT_FILE)\n',
    );
    const cross = platform === 'linux-armhf' ? 'arm-linux-gnueabihf-' : '';
    const privateRuntime =
      '-static-libstdc++ -shared-libgcc -Wl,--exclude-libs,libstdc++.a:libgcc.a';
    const musl = `LDFLAGS= ${privateRuntime}`;
    expect(commands(h)).toEqual([
      withEnv(
        `${python} -c import sys; sys.exit('JACK 1.9.22 requires Python 3.11 or earlier for its bundled Waf') if sys.version_info >= (3, 12) else None`,
        musl,
      ),
      withEnv(
        [
          `${python} ./waf configure`,
          `--prefix=${h.deps} --libdir=${h.deps}/lib`,
          '--autostart=none --alsa=no --firewire=no --iio=no --portaudio=no --winmme=no --celt=no --opus=no',
          '--samplerate=no --systemd=no --db=no --doxygen=no',
        ].join(' '),
        `CC=${cross}gcc`,
        `CXX=${cross}g++`,
        musl,
      ),
      withEnv(`${python} ./waf build -j4`, musl),
      withEnv(`${python} ./waf install`, musl),
    ]);
  });
  it('ships libjack (LGPL-2.1-or-later) on Linux', () => {
    expect(recipe('jack2').license).toBe('LGPL-2.1-or-later');
    expect(platformsOf('jack2')).toEqual(['linux-x64', 'linux-arm64', 'linux-armhf']);
    expect(recipe('jack2').linkage!.modes.shared!.runtime).toEqual([{ value: 'lib/libjack.so*' }]);
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
    put(alc, 'unmodified upstream source\n');
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
        '-DALSOFT_BACKEND_PIPEWIRE=OFF',
        '-DALSOFT_BACKEND_PULSEAUDIO=OFF',
        '-DALSOFT_BACKEND_JACK=OFF',
        '-DALSOFT_BACKEND_SNDIO=OFF',
        '-DALSOFT_BACKEND_PORTAUDIO=OFF',
        '-DALSOFT_BACKEND_SDL2=OFF',
        '-DALSOFT_BACKEND_SDL3=OFF',
        ...(platform.startsWith('linux-')
          ? ['-DALSOFT_REQUIRE_ALSA=ON', '-DALSOFT_DLOPEN=OFF']
          : []),
      ]).map((line) =>
        platform === 'win-arm64'
          ? `${line} [CXXFLAGS=${h.base['CXXFLAGS'] ?? ''} -include stdlib.h]`
          : line,
      ),
    );
    expect(h.read(pc)).toContain(`Libs.private: -lm ${cxxRuntime(platform)}`);
    expect(h.read(pc).includes('Requires.private: alsa')).toBe(platform.startsWith('linux-'));
    expect(h.read(alc)).toBe('unmodified upstream source\n');
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
