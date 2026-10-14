// ffmpeg-build doctor: is this machine ready to build (and test) these targets? Every probe is a fake here.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureEngineRoot, runCli } from './helpers.ts';
import { type Host, parseOsRelease } from '../src/build/host.ts';
import { type DoctorEnv, runDoctor, vulkanShaders, wantsVulkan14 } from '../src/commands/doctor.ts';
import { BINFMT } from '../src/commands/test.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { type Folder, parseFolderText } from '../src/targets.ts';

const ubuntu: Host = {
  os: 'linux',
  arch: 'x64',
  musl: false,
  distro: parseOsRelease('ID=ubuntu\nPRETTY_NAME="Ubuntu 24.04 LTS"')!,
};
const distro = (text: string): Host => ({ ...ubuntu, distro: parseOsRelease(text)! });
const windows = (msystem?: string, arch = 'x64'): Host => ({
  os: 'win32',
  arch,
  musl: false,
  ...(msystem ? { msystem } : {}),
});
const mac: Host = { os: 'darwin', arch: 'arm64', musl: false };

const LINUX_TOOLS = [
  'bash',
  'make',
  'cmake',
  'meson',
  'ninja',
  'nasm',
  'pkg-config',
  'git',
  'tar',
  'gzip',
  'curl',
  'autoconf',
  'automake',
  'libtoolize',
  'perl',
  'strings',
  'gcc',
  'g++',
  'patchelf',
  'xxd',
  'python3',
  'gperf',
  'xz',
  'cmp',
];

interface Fake {
  host: Host;
  docker?: 'ready' | 'missing' | 'stopped' | 'denied';
  /** commands that work, with what they print (`cmd arg arg`) */
  commands?: Record<string, string>;
  tools?: string[];
  files?: string[];
  env?: NodeJS.ProcessEnv;
  brew?: string[];
}

/** What fake probes wrote (glslc's test shader). */
const written: string[] = [];

function fake(f: Fake): DoctorEnv {
  const commands: Record<string, string> = { 'git --version': 'git version 2.47.1', ...f.commands };
  const tools = new Set(f.tools ?? []);
  const files = new Set(f.files ?? []);
  return {
    host: f.host,
    env: f.env ?? {},
    run: (cmd, args) => {
      if (cmd === 'docker') {
        const status = f.docker ?? 'ready';
        if (status === 'ready') {
          return { ok: true, out: '27.3.1\n', missing: false };
        }
        if (status === 'missing') {
          return { ok: false, out: '', missing: true };
        }
        return {
          ok: false,
          out:
            status === 'denied'
              ? 'permission denied while trying to connect to the Docker daemon socket'
              : 'Cannot connect to the Docker daemon. Is the docker daemon running?',
          missing: false,
        };
      }
      const out = commands[[cmd, ...args].join(' ')];
      return out === undefined
        ? {
            ok: false,
            out: '',
            missing: !Object.keys(commands).some((k) => k.startsWith(`${cmd} `)),
          }
        : { ok: true, out, missing: false };
    },
    missingTools: (wanted) => wanted.filter((t) => !tools.has(t)),
    exists: (p) => files.has(p),
    arm64Image: (platform) => platform === 'linux-arm64' || platform === 'linux-musl-arm64',
    brewWanted: ['autoconf', 'cmake', 'nasm', 'shaderc'],
    writeProbe: (name, text) => {
      written.push(text);
      return `/tmp/${name}`;
    },
  };
}

function folder(text: string): Folder {
  const r = parseFolderText(text, mkdtempSync(join(tmpdir(), 'ffmpeg-build-doctor-')));
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return r.folder;
}
const one = (platform: string, extra = '') =>
  folder(`${extra}targets:\n  t: { platform: ${platform}, license: lgplv3, ffmpeg: 9 }\n`);

interface Json {
  ok: boolean;
  error?: string;
  problems?: string[];
  host: string;
  needs: { what: string; ok: boolean; have?: string; install?: string }[];
  targets: {
    name: string;
    platform: string;
    buildsIn: string | null;
    testsIn: string | null;
    cantBuild?: string;
    cantTest?: string;
    needs: { what: string; ok: boolean; have?: string; install?: string; optional?: boolean }[];
  }[];
}
const json = (input: Parameters<typeof runDoctor>[0], env: DoctorEnv) => {
  const r = runDoctor({ ...input, json: true }, env);
  return { exitCode: r.exitCode, out: JSON.parse(r.output) as Json };
};

describe('doctor: Docker builds', () => {
  it('is ready when Docker runs: exit 0, with its version', () => {
    const r = runDoctor({ folder: one('linux-x64') }, fake({ host: ubuntu }));
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe(
      [
        'this machine: Linux x64, Ubuntu 24.04 LTS',
        '  ✓ git (lock and update): 2.47.1',
        '',
        't (linux-x64): builds in Docker, tests here',
        '  ✓ Docker: 27.3.1',
        '',
        'ready: every target builds and tests here',
      ].join('\n'),
    );
    expect(json({ folder: one('linux-x64') }, fake({ host: ubuntu })).out).toEqual({
      ok: true,
      host: 'Linux x64, Ubuntu 24.04 LTS',
      needs: [{ what: 'git (lock and update)', ok: true, have: '2.47.1' }],
      targets: [
        {
          name: 't',
          platform: 'linux-x64',
          buildsIn: 'docker',
          testsIn: 'here',
          needs: [{ what: 'Docker', ok: true, have: '27.3.1' }],
        },
      ],
    });
  });

  it.each([
    [
      'ID=ubuntu\nNAME=Ubuntu',
      'on Ubuntu: sudo apt-get install docker.io && sudo systemctl enable --now docker',
    ],
    [
      'ID=fedora\nNAME=Fedora',
      'on Fedora: sudo dnf install moby-engine && sudo systemctl enable --now docker',
    ],
    [
      'ID=opensuse-leap\nID_LIKE="suse opensuse"\nNAME=openSUSE',
      'on openSUSE: sudo zypper install docker && sudo systemctl enable --now docker',
    ],
    [
      'ID=arch\nNAME=Arch',
      'on Arch: sudo pacman -S --needed docker && sudo systemctl enable --now docker',
    ],
    [
      'ID=alpine\nNAME=Alpine',
      'on Alpine: sudo apk add docker && sudo rc-update add docker && sudo rc-service docker start',
    ],
  ])('says how to install a missing Docker on %j', (release, install) => {
    const r = json(
      { folder: one('linux-x64') },
      fake({ host: distro(release), docker: 'missing' }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.out.ok).toBe(false);
    expect(r.out.error).toBe("1 of 1 target isn't ready here");
    expect(r.out.problems).toEqual(['t: Docker is not installed']);
    expect(r.out.targets[0]!.needs).toEqual([
      { what: 'Docker is not installed', ok: false, install },
    ]);
  });

  it('says how to start a stopped Docker, and how to be allowed to use it', () => {
    const stopped = runDoctor(
      { folder: one('win-x64') },
      fake({ host: windows(), docker: 'stopped' }),
    );
    expect(stopped.exitCode).toBe(1);
    expect(stopped.output).toContain(
      '  ✗ Docker is installed but not running\n      start Docker Desktop',
    );
    expect(
      runDoctor({ folder: one('linux-x64') }, fake({ host: ubuntu, docker: 'stopped' })).output,
    ).toContain('      sudo systemctl start docker');
    expect(
      runDoctor({ folder: one('linux-x64') }, fake({ host: ubuntu, docker: 'denied' })).output,
    ).toContain(
      "  ✗ Docker is running, but this user can't use it\n      sudo usermod -aG docker $USER, then log in again",
    );
    const desktop = runDoctor({ folder: one('linux-x64') }, fake({ host: mac, docker: 'missing' }));
    expect(desktop.output).toContain(
      'install Docker Desktop (brew install --cask docker-desktop) and start it',
    );
  });

  it('needs qemu registered for arm64 images on an x64 Linux host', () => {
    const missing = json({ platform: 'linux-arm64' }, fake({ host: ubuntu }));
    expect(missing.exitCode).toBe(1);
    expect(missing.out.targets[0]!.needs).toContainEqual({
      what: 'qemu for arm64 containers (binfmt qemu-aarch64)',
      ok: false,
      install: `docker run --privileged --rm ${BINFMT} --install arm64`,
    });
    const there = json(
      { platform: 'linux-arm64' },
      fake({ host: ubuntu, files: ['/proc/sys/fs/binfmt_misc/qemu-aarch64'] }),
    );
    expect(there.out.targets[0]!.needs).toContainEqual({
      what: 'qemu for arm64 containers (binfmt qemu-aarch64)',
      ok: true,
    });
    // an arm64 host runs them as they are
    const arm = json({ platform: 'linux-arm64' }, fake({ host: { ...ubuntu, arch: 'arm64' } }));
    expect(arm.exitCode).toBe(0);
    expect(arm.out.targets[0]!.needs.map((n) => n.what)).toEqual(['Docker']);
  });
});

describe('doctor: native builds', () => {
  const native = (platform: string) => one(platform, `build:\n  ${platform}: { in: here }\n`);

  it('is ready when every tool is there, naming the compiler', () => {
    const r = json(
      { folder: native('linux-x64') },
      fake({
        host: ubuntu,
        tools: LINUX_TOOLS,
        commands: { 'gcc --version': 'gcc (Ubuntu 13.2.0) 13.2.0\nCopyright' },
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.out.targets[0]).toMatchObject({
      buildsIn: 'here',
      needs: [{ what: 'native build tools', ok: true, have: 'gcc (Ubuntu 13.2.0) 13.2.0' }],
    });
  });

  it.each([
    ['ID=debian\nNAME=Debian', 'on Debian: sudo apt-get install cmake ninja-build build-essential'],
    ['ID=fedora\nNAME=Fedora', 'on Fedora: sudo dnf install cmake ninja-build gcc-c++'],
    [
      'ID=almalinux\nID_LIKE="rhel centos fedora"\nNAME=AlmaLinux',
      'on AlmaLinux: sudo dnf install cmake ninja-build gcc-c++ (meson, nasm and patchelf come from EPEL: sudo dnf install epel-release, and enable CRB, first)',
    ],
    [
      'ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\nNAME=Tumbleweed',
      'on Tumbleweed: sudo zypper install cmake ninja gcc-c++',
    ],
    ['ID=arch\nNAME=Arch', 'on Arch: sudo pacman -S --needed cmake ninja base-devel'],
  ])('names the missing tools and their packages on %j', (release, install) => {
    const tools = LINUX_TOOLS.filter((t) => !['cmake', 'ninja', 'g++'].includes(t));
    const r = json({ folder: native('linux-x64') }, fake({ host: distro(release), tools }));
    expect(r.exitCode).toBe(1);
    expect(r.out.targets[0]!.needs).toEqual([
      { what: 'native build tools: cmake, ninja, g++ missing', ok: false, install },
    ]);
  });

  it("says why a platform can't build natively on this machine", () => {
    const r = json({ folder: native('linux-arm64') }, fake({ host: ubuntu, tools: LINUX_TOOLS }));
    expect(r.exitCode).toBe(1);
    expect(r.out.targets[0]).toMatchObject({
      buildsIn: null,
      cantBuild:
        'linux-arm64 builds natively only on a linux-arm64 (glibc) machine; this machine is Linux x64 (use --in docker)',
    });
    expect(runDoctor({ folder: native('linux-arm64') }, fake({ host: ubuntu })).output).toContain(
      "t (linux-arm64): can't build here: linux-arm64 builds natively only",
    );
  });
});

describe('doctor: glslc for Vulkan builds', () => {
  const native = (platform: string) => one(platform, `build:\n  ${platform}: { in: here }\n`);
  const PROBE =
    'glslc --target-env=vulkan1.4 --target-spv=spv1.6 -std=460 -fshader-stage=compute /tmp/probe.comp -o /tmp/probe.comp.spv';
  const run = (host: Host, ffmpeg: string, commands: Record<string, string>) =>
    json(
      { folder: native(host.os === 'win32' ? 'win-x64' : 'linux-x64'), shaders: () => ffmpeg },
      fake({
        host,
        tools: [...LINUX_TOOLS, 'objdump', 'gendef', 'llvm-dlltool'],
        commands: { 'glslc --version': 'shaderc v2026.4\nspirv-tools', ...commands },
      }),
    );

  it('is needed only by builds that compile Vulkan shaders', () => {
    const plain = json({ folder: native('linux-x64') }, fake({ host: ubuntu, tools: LINUX_TOOLS }));
    expect(plain.out.targets[0]!.needs.map((n) => n.what)).toEqual(['native build tools']);
  });

  it("probes FFmpeg's Vulkan 1.4 compile, with a tiny compute shader", () => {
    written.length = 0;
    const ok = run(ubuntu, '9.1.0', { [PROBE]: '' });
    expect(ok.exitCode).toBe(0);
    expect(ok.out.targets[0]!.needs[1]).toEqual({
      what: 'glslc (Vulkan 1.4 shaders)',
      ok: true,
      have: 'shaderc v2026.4',
    });
    expect(written).toEqual(['#version 460\nlayout (local_size_x = 1) in;\nvoid main() {}\n']);
    const old = run(ubuntu, '9', {});
    expect(old.exitCode).toBe(1);
    expect(old.out.targets[0]!.needs[1]).toEqual({
      what: 'glslc too old for Vulkan 1.4',
      ok: false,
      have: 'shaderc v2026.4',
      install:
        "a newer glslc: on Ubuntu 24.04 LTS: sudo apt-get install glslc, if the distribution's is new enough; else build shaderc's glslc, as images/linux-x64/Dockerfile does",
    });
    // FFmpeg before 8.1 doesn't ask for Vulkan 1.4
    expect(run(ubuntu, '8.0.1', {}).exitCode).toBe(0);
  });

  it.each([
    ['ID=fedora\nNAME=Fedora', 'on Fedora: sudo dnf install glslc'],
    [
      'ID=opensuse-leap\nID_LIKE="suse opensuse"\nNAME=Leap',
      'on Leap: sudo zypper install shaderc',
    ],
    ['ID=arch\nNAME=Arch', 'on Arch: sudo pacman -S --needed shaderc'],
  ])('says how to install a missing glslc on %j', (release, install) => {
    const r = run(distro(release), '9', { 'glslc --version': undefined as unknown as string });
    expect(r.out.targets[0]!.needs[1]).toEqual({
      what: 'glslc (Vulkan shaders)',
      ok: false,
      install,
    });
  });

  it("installs MSYS2's shaderc", () => {
    const r = run(windows('UCRT64'), '9', { 'glslc --version': undefined as unknown as string });
    expect(r.out.targets[0]!.needs[1]).toEqual({
      what: 'glslc (Vulkan shaders)',
      ok: false,
      install: 'in the MSYS2 shell: pacman -S --needed mingw-w64-ucrt-x86_64-shaderc',
    });
  });

  it("decides from the target's resolved plan: Vulkan options, or whisper with ggml's Vulkan backend", () => {
    const data = loadEngineData(packageRoot);
    const f = folder(
      [
        'targets:',
        '  plain: { platform: linux-x64, license: lgplv3, ffmpeg: 9 }',
        '  vk: { platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [vulkan] }',
        '  whisper3: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [whisper] }',
        '  whisper2: { platform: linux-x64, license: gplv2, ffmpeg: 9, with: [whisper] }',
        '',
      ].join('\n'),
    );
    const shaders = (name: string) =>
      vulkanShaders(
        f,
        f.targets.find((t) => t.name === name)!,
        data,
      );
    expect(shaders('plain')).toBeUndefined();
    expect(shaders('vk')).toBe('9');
    expect(shaders('whisper3')).toBe('9');
    expect(shaders('whisper2')).toBeUndefined();
  });

  it('knows which FFmpeg asks for Vulkan 1.4', () => {
    expect(['8', '8.1', '8.1.2', '9', '10.0'].map(wantsVulkan14)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(['7', '7.1.1', '8.0', '8.0.3'].map(wantsVulkan14)).toEqual([false, false, false, false]);
  });
});

describe('doctor: MSYS2', () => {
  const native = (platform: string) => one(platform, `build:\n  ${platform}: { in: here }\n`);
  const WIN_TOOLS = [...LINUX_TOOLS, 'clang', 'clang++', 'objdump', 'gendef', 'llvm-dlltool'];

  it('outside MSYS2, says which environment to install and open', () => {
    const r = json({ folder: native('win-x64') }, fake({ host: windows() }));
    expect(r.exitCode).toBe(1);
    expect(r.out.targets[0]!.buildsIn).toBeNull();
    expect(r.out.targets[0]!.needs).toEqual([
      {
        what: 'an MSYS2 MINGW64 shell',
        ok: false,
        install: expect.stringMatching(
          /^install MSYS2 \(winget install MSYS2\.MSYS2\), open its MINGW64 shell, run ffmpeg-build from there, and in it: pacman -S --needed .* mingw-w64-x86_64-gcc mingw-w64-x86_64-cmake /,
        ),
      },
    ]);
    const arm = json({ folder: native('win-arm64') }, fake({ host: windows('MINGW64', 'arm64') }));
    expect(arm.out.targets[0]!.needs[0]).toMatchObject({
      what: 'an MSYS2 CLANGARM64 shell',
      ok: false,
      have: 'MSYSTEM=MINGW64',
      install: expect.stringContaining('mingw-w64-clang-aarch64-clang'),
    });
  });

  it("in the right shell, checks the environment's tools", () => {
    const ucrt = json(
      { folder: native('win-x64') },
      fake({ host: windows('UCRT64'), tools: WIN_TOOLS.filter((t) => t !== 'nasm') }),
    );
    expect(ucrt.exitCode).toBe(1);
    expect(ucrt.out.targets[0]).toMatchObject({ buildsIn: 'here' });
    expect(ucrt.out.targets[0]!.needs[0]).toMatchObject({
      what: 'native build tools: nasm missing',
      ok: false,
      install: expect.stringContaining('mingw-w64-ucrt-x86_64-nasm'),
    });
    const ready = json(
      { folder: native('win-x64') },
      fake({
        host: windows('MINGW64'),
        tools: WIN_TOOLS,
        commands: { 'gcc --version': 'gcc.exe (Rev2, Built by MSYS2 project) 15.2.0' },
      }),
    );
    expect(ready.exitCode).toBe(0);
    expect(ready.out.targets[0]!.needs).toEqual([
      {
        what: 'native build tools',
        ok: true,
        have: 'gcc.exe (Rev2, Built by MSYS2 project) 15.2.0',
      },
    ]);
  });
});

describe('doctor: a Mac', () => {
  const xcode = {
    'xcode-select -p': '/Applications/Xcode.app/Contents/Developer',
    'xcodebuild -version': 'Xcode 26.0\nBuild version 17A324',
    'brew --version': 'Homebrew 4.6.0',
    'brew list --formula -1': 'autoconf\ncmake\nnasm\nshaderc\n',
    'xcrun --find clang': '/usr/bin/clang',
  };

  it('builds Apple with Xcode and the Homebrew tools', () => {
    const r = json({ folder: one('osx-arm64') }, fake({ host: mac, commands: xcode }));
    expect(r.exitCode).toBe(0);
    expect(r.out.targets[0]).toEqual({
      name: 't',
      platform: 'osx-arm64',
      buildsIn: 'here',
      testsIn: 'here',
      needs: [
        { what: 'Xcode', ok: true, have: 'Xcode 26.0' },
        {
          what: 'Homebrew build tools (platforms/apple-brew.txt)',
          ok: true,
          have: 'Homebrew 4.6.0',
        },
      ],
    });
  });

  it('names the Homebrew packages that are missing, and Xcode when only the Command Line Tools are there', () => {
    const r = json(
      { folder: one('ios-arm64') },
      fake({
        host: mac,
        commands: {
          ...xcode,
          'xcode-select -p': '/Library/Developer/CommandLineTools',
          'xcodebuild -version': undefined as unknown as string,
          'brew list --formula -1': 'cmake\n',
        },
      }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.out.targets[0]!.needs).toEqual([
      {
        what: 'Xcode (only the Command Line Tools are selected)',
        ok: false,
        install:
          'install Xcode (App Store), then: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer',
      },
      {
        what: 'Homebrew build tools (platforms/apple-brew.txt): autoconf, nasm, shaderc missing',
        ok: false,
        install: 'brew install autoconf nasm shaderc',
      },
      expect.objectContaining({
        what: "Xcode's clang (xcrun)",
      }) as unknown as Json['needs'][number],
    ]);
    const noBrew = json(
      { folder: one('osx-arm64') },
      fake({
        host: mac,
        commands: {
          'xcode-select -p': xcode['xcode-select -p'],
          'xcodebuild -version': 'Xcode 26.0',
        },
      }),
    );
    expect(noBrew.out.targets[0]!.needs[1]).toEqual({
      what: 'Homebrew',
      ok: false,
      install:
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)", then: brew install autoconf cmake nasm shaderc',
    });
  });

  it('needs Rosetta to test an x64 build on Apple silicon', () => {
    const r = json({ folder: one('osx-x64') }, fake({ host: mac, commands: xcode }));
    expect(r.exitCode).toBe(1);
    expect(r.out.targets[0]!.needs).toContainEqual({
      what: 'Rosetta (runs x86_64 builds)',
      ok: false,
      install: 'softwareupdate --install-rosetta --agree-to-license',
    });
    const rosetta = json(
      { folder: one('osx-x64') },
      fake({ host: mac, commands: { ...xcode, 'arch -x86_64 /usr/bin/true': '' } }),
    );
    expect(rosetta.exitCode).toBe(0);
  });

  it("can't build Apple anywhere else", () => {
    const r = json({ folder: one('ios-arm64') }, fake({ host: ubuntu }));
    expect(r.exitCode).toBe(1);
    expect(r.out.targets[0]).toMatchObject({
      buildsIn: null,
      cantBuild: 'ios-arm64 builds only on a Mac, with Xcode',
      testsIn: null,
      cantTest: 'linking a program against a ios-arm64 build needs a Mac with Xcode',
    });
  });
});

describe('doctor: testing', () => {
  it("says a build this machine can't run can't be tested here", () => {
    const r = runDoctor({ folder: one('win-x64') }, fake({ host: ubuntu }));
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain(
      "t (win-x64): builds in Docker; can't test here: win-x64 builds don't run on this machine (it runs linux-x64)",
    );
  });

  it('tests musl and armhf builds in containers, armhf with qemu for 32-bit ARM', () => {
    const musl = json({ platform: 'linux-musl-x64' }, fake({ host: ubuntu }));
    expect(musl.exitCode).toBe(0);
    expect(musl.out.targets[0]!.testsIn).toBe('docker');
    const armhf = json({ platform: 'linux-armhf' }, fake({ host: ubuntu }));
    expect(armhf.exitCode).toBe(1);
    expect(armhf.out.targets[0]!.needs).toContainEqual({
      what: 'qemu for 32-bit ARM containers (binfmt qemu-arm)',
      ok: false,
      install: `docker run --privileged --rm ${BINFMT} --install arm`,
    });
  });

  it('links Android builds with the NDK; adb, to run them, is optional', () => {
    const none = json({ platform: 'android-arm64' }, fake({ host: ubuntu }));
    expect(none.exitCode).toBe(1);
    expect(none.out.targets[0]!.needs).toContainEqual({
      what: 'the Android NDK (ANDROID_NDK_HOME)',
      ok: false,
      install:
        "install the NDK (Android Studio's SDK Manager, or https://developer.android.com/ndk/downloads) and set ANDROID_NDK_HOME to its folder",
    });
    const ndk = '/opt/ndk';
    const there = json(
      { platform: 'android-arm64' },
      fake({
        host: ubuntu,
        env: { ANDROID_NDK_HOME: ndk },
        files: [`${ndk}/toolchains/llvm/prebuilt`],
      }),
    );
    expect(there.exitCode).toBe(0);
    expect(there.out.targets[0]!.needs).toContainEqual({
      what: 'the Android NDK (ANDROID_NDK_HOME)',
      ok: true,
      have: ndk,
    });
    expect(there.out.targets[0]!.needs).toContainEqual(
      expect.objectContaining({
        what: 'adb (runs the test program on a device or emulator)',
        ok: false,
        optional: true,
      }),
    );
    const win = json({ platform: 'android-arm64' }, fake({ host: windows() }));
    expect(win.out.targets[0]!.cantTest).toBe(
      'linking a program against an android-arm64 build needs Linux or macOS with the Android NDK',
    );
  });

  it("needs Git Bash on Windows for a target's .sh tests", () => {
    const f = folder(
      'targets:\n  t: { platform: win-x64, license: lgplv3, ffmpeg: 9, tests: [smoke.sh] }\n',
    );
    const r = json({ folder: f }, fake({ host: windows() }));
    expect(r.exitCode).toBe(1);
    expect(r.out.targets[0]!.needs).toContainEqual({
      what: 'Git Bash (runs the .sh tests)',
      ok: false,
      install: 'install Git for Windows (winget install Git.Git), or set BASH to its bash.exe',
    });
    const bash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const ok = json({ folder: f }, fake({ host: windows(), env: { BASH: bash }, files: [bash] }));
    expect(ok.exitCode).toBe(0);
  });
});

describe('doctor: choosing targets', () => {
  const two = folder(
    'targets:\n  a: { platform: linux-x64, license: lgplv3, ffmpeg: 9 }\n  b: { platform: win-x64, license: lgplv3, ffmpeg: 9 }\n',
  );

  it('checks every target by default, or those --target and --platform choose', () => {
    expect(json({ folder: two }, fake({ host: ubuntu })).out.targets.map((t) => t.name)).toEqual([
      'a',
      'b',
    ]);
    const chosen = json({ folder: two, platform: 'linux-*' }, fake({ host: ubuntu }));
    expect(chosen.exitCode).toBe(0);
    expect(chosen.out.targets.map((t) => t.name)).toEqual(['a']);
    expect(json({ folder: two, target: 'b' }, fake({ host: ubuntu })).out.targets[0]!.name).toBe(
      'b',
    );
    expect(() => runDoctor({ folder: two, target: 'c' }, fake({ host: ubuntu }))).toThrow(
      /no target c/,
    );
  });

  it('checks platforms without a folder', () => {
    const r = json({ platform: 'linux-x64,linux-musl-*' }, fake({ host: ubuntu }));
    expect(r.out.targets.map((t) => `${t.name} ${String(t.buildsIn)}`)).toEqual([
      'linux-x64 docker',
      'linux-musl-x64 docker',
      'linux-musl-arm64 docker',
    ]);
    expect(() => runDoctor({}, fake({ host: ubuntu }))).toThrow(
      'no ffmpeg-build.yml here: say which platforms to check with --platform <patterns>',
    );
    expect(() => runDoctor({ target: 'x' }, fake({ host: ubuntu }))).toThrow(
      'no ffmpeg-build.yml here: --target needs one (--platform <patterns> checks platforms without it)',
    );
    expect(() => runDoctor({ platform: 'beos-*' }, fake({ host: ubuntu }))).toThrow(
      '--platform: beos-* names no platform ffmpeg-build knows',
    );
  });

  it('counts a missing git as not ready', () => {
    const r = json(
      { folder: two, platform: 'linux-*' },
      fake({ host: ubuntu, commands: { 'git --version': undefined as unknown as string } }),
    );
    expect(r.exitCode).toBe(1);
    expect(r.out.needs).toEqual([
      {
        what: 'git (lock and update)',
        ok: false,
        install: 'on Ubuntu 24.04 LTS: sudo apt-get install git',
      },
    ]);
    expect(r.out.problems).toEqual(['git (lock and update)']);
  });
});

describe('doctor: many targets', () => {
  const many = folder(
    [
      'targets:',
      ...['linux-x64', 'linux-arm64', 'win-x64', 'win-arm64', 'osx-arm64', 'ios-arm64'].flatMap(
        (p) => [
          `  ${p}-a: { platform: ${p}, license: lgplv3, ffmpeg: 9 }`,
          `  ${p}-b: { platform: ${p}, license: gplv3, ffmpeg: 9 }`,
        ],
      ),
      '',
    ].join('\n'),
  );

  it('says each requirement once, with the targets that need it, and why the others cannot build or test', () => {
    const r = runDoctor({ folder: many }, fake({ host: ubuntu, docker: 'stopped' }));
    expect(r.exitCode).toBe(1);
    expect(r.output).toBe(
      [
        'this machine: Linux x64, Ubuntu 24.04 LTS',
        '  ✓ git (lock and update): 2.47.1',
        '',
        "  ✗ 8 targets can't test here: linux-arm64, win-*, osx-arm64 builds don't run on this machine (it runs linux-x64)",
        "  ✗ 4 targets can't build here: osx-arm64, ios-arm64 builds only on a Mac, with Xcode",
        "  ✗ 2 targets can't test here: linking a program against a ios-arm64 build needs a Mac with Xcode",
        '  ✗ Docker is installed but not running (8 targets: linux-x64, linux-arm64, win-*)',
        '      sudo systemctl start docker',
        '  ✗ qemu for arm64 containers (binfmt qemu-aarch64) (2 targets: linux-arm64)',
        `      docker run --privileged --rm ${BINFMT} --install arm64`,
        '',
        '5 things missing for 12 targets',
      ].join('\n'),
    );
  });

  it('groups a reason across platforms, and is ready when everything is there', () => {
    const r = runDoctor(
      { folder: many, platform: 'osx-*,ios-*' },
      fake({ host: ubuntu, files: ['/proc/sys/fs/binfmt_misc/qemu-aarch64'] }),
    );
    expect(r.output).toContain(
      "  ✗ 4 targets can't build here: osx-arm64, ios-arm64 builds only on a Mac, with Xcode",
    );
    const linux = runDoctor({ folder: many, platform: 'linux-x64' }, fake({ host: ubuntu }));
    expect(linux.exitCode).toBe(0);
    expect(linux.output).toContain('  ✓ Docker: 27.3.1 (2 targets: linux-x64)');
    expect(linux.output).toMatch(/\nready: every target builds and tests here$/);
    // --json keeps each target's own list
    expect(
      json({ folder: many, platform: 'linux-x64' }, fake({ host: ubuntu })).out.targets,
    ).toHaveLength(2);
  });
});

describe('doctor: Git Bash is not MSYS2', () => {
  it('says so, and points to MSYS2 for native win-* builds', () => {
    const host: Host = { ...windows('MINGW64'), gitBash: true };
    const r = json({ folder: one('win-x64', 'build:\n  win-x64: { in: here }\n') }, fake({ host }));
    expect(r.out.host).toBe('Windows x64, Git Bash (not MSYS2)');
    expect(r.out.targets[0]!.cantBuild).toContain('this is Git Bash (not MSYS2)');
    expect(r.out.targets[0]!.needs[0]).toMatchObject({
      what: 'an MSYS2 MINGW64 shell',
      ok: false,
      have: 'Git Bash (not MSYS2)',
      install: expect.stringContaining('install MSYS2 (winget install MSYS2.MSYS2)'),
    });
  });
});

describe('ffmpeg-build doctor', () => {
  const env = { FFMPEG_BUILD_DATA: fixtureEngineRoot };
  const empty = () => mkdtempSync(join(tmpdir(), 'ffmpeg-build-doctor-cli-'));

  it('is a usage error (exit 2) without a folder or --platform', () => {
    const r = runCli(['doctor'], { cwd: empty(), env });
    expect(r.exitCode).toBe(2);
    expect(r.err).toContain('say which platforms to check with --platform <patterns>');
    const j = runCli(['doctor', '--json'], { cwd: empty(), env });
    expect(j.exitCode).toBe(2);
    expect(JSON.parse(j.out)).toEqual({
      error: 'no ffmpeg-build.yml here: say which platforms to check with --platform <patterns>',
      problems: [],
    });
  });

  it("probes this machine's own tools", () => {
    const r = runCli(['doctor', '--platform', 'linux-x64', '--json'], { cwd: empty(), env });
    expect([0, 1]).toContain(r.exitCode);
    const out = JSON.parse(r.out) as Json;
    expect(out.targets[0]).toMatchObject({ name: 'linux-x64', buildsIn: 'docker' });
  });
});
