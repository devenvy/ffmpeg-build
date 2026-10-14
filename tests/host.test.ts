// --in here: which platforms a machine builds natively, the tools that takes, and what the build's identity records.
import { describe, expect, it } from 'vitest';

import {
  brewPackages,
  currentHost,
  dockerInstall,
  dockerStart,
  type Host,
  hostFacts,
  hostSummary,
  installHint,
  missingTools,
  msys2Environment,
  nativeKind,
  nativeTools,
  parseOsRelease,
} from '../src/build/host.ts';

const linux: Host = { os: 'linux', arch: 'x64', musl: false };
const win = (msystem?: string): Host => ({
  os: 'win32',
  arch: 'x64',
  musl: false,
  ...(msystem ? { msystem } : {}),
});

describe('native builds', () => {
  it('a Linux machine builds its own Linux platform, glibc only', () => {
    expect(nativeKind('linux-x64', linux)).toEqual({ kind: 'linux' });
    expect(nativeKind('linux-arm64', { ...linux, arch: 'arm64' })).toEqual({ kind: 'linux' });
    expect(nativeKind('linux-arm64', linux)).toEqual({
      error:
        'linux-arm64 builds natively only on a linux-arm64 (glibc) machine; this machine is Linux x64 (use --in docker)',
    });
    expect(nativeKind('linux-x64', { ...linux, musl: true })).toEqual({
      error:
        'linux-x64 builds natively only on a linux-x64 (glibc) machine; this machine is Linux (musl) x64 (use --in docker)',
    });
  });

  it('Windows builds win-* in the matching MSYS2 shell', () => {
    expect(nativeKind('win-x64', win('MINGW64'))).toEqual({ kind: 'windows' });
    expect(nativeKind('win-x64', win('UCRT64'))).toEqual({ kind: 'windows' });
    expect(nativeKind('win-arm64', win('CLANGARM64'))).toEqual({ kind: 'windows' });
    expect(nativeKind('win-arm64', win('MINGW64'))).toEqual({
      error:
        'win-arm64 builds natively in an MSYS2 CLANGARM64 shell, not MINGW64; or use --in docker',
    });
    expect(nativeKind('win-x64', win())).toEqual({
      error:
        'win-x64 builds natively in an MSYS2 MINGW64 or UCRT64 or CLANG64 shell (MSYSTEM is not set: run ffmpeg-build from that MSYS2 shell); or use --in docker',
    });
    expect(nativeKind('win-x64', linux)).toEqual({
      error:
        'win-x64 builds natively only on Windows, in MSYS2; this machine is Linux x64 (use --in docker)',
    });
  });

  it('Apple only on a Mac; the rest only in Docker', () => {
    expect(nativeKind('osx-arm64', { os: 'darwin', arch: 'arm64', musl: false })).toEqual({
      kind: 'apple',
    });
    expect(nativeKind('ios-arm64', linux)).toEqual({
      error: 'ios-arm64 builds only on a Mac, with Xcode',
    });
    expect(nativeKind('android-arm64', linux)).toEqual({
      error:
        'android-arm64 builds only in Docker (--in here is for linux-x64, linux-arm64, win-* and Apple)',
    });
    expect(nativeKind('linux-musl-x64', linux)).toEqual({
      error:
        'linux-musl-x64 builds only in Docker (--in here is for linux-x64, linux-arm64, win-* and Apple)',
    });
  });

  it('names the missing tools and how to install them', () => {
    const have = new Set(['bash', 'make', 'gcc', 'g++']);
    const missing = missingTools(nativeTools('linux', 'linux-x64'), {}, (t) => have.has(t));
    expect(missing).toContain('cmake');
    expect(missing).toContain('patchelf');
    expect(missing).not.toContain('gcc');
    expect(nativeTools('windows', 'win-arm64')).toContain('clang');
    expect(nativeTools('windows', 'win-x64')).toContain('llvm-dlltool');
    expect(installHint('linux', linux)).toContain('apt-get install build-essential cmake meson');
    expect(installHint('windows', win('MINGW64'))).toContain(
      'mingw-w64-x86_64-gcc mingw-w64-x86_64-cmake',
    );
    expect(installHint('windows', win('CLANGARM64'))).toContain('mingw-w64-clang-aarch64-clang');
  });

  it("records the compiler and tools' versions, and the MSYS2 environment, as the toolchain", () => {
    const facts = hostFacts('windows', 'win-x64', { MSYSTEM: 'MINGW64' }, (t) => `${t} 1.0`);
    expect(facts).toContain('gcc: gcc 1.0');
    expect(facts).toContain('msystem: MINGW64');
    expect(hostFacts('linux', 'linux-x64', {}, (t) => `${t} 2`)).toContain('libc: ldd 2');
    expect(hostFacts('linux', 'linux-x64', {}, (t) => (t === 'gcc' ? 'gcc 14' : 'x'))).not.toBe(
      hostFacts('linux', 'linux-x64', {}, (t) => (t === 'gcc' ? 'gcc 15' : 'x')),
    );
  });
});

const osRelease = (lines: Record<string, string>) =>
  Object.entries(lines)
    .map(([k, v]) => `${k}="${v}"`)
    .join('\n');
const on = (text: string): Host => ({ ...linux, distro: parseOsRelease(text)! });

describe('the Linux distribution, and how to install on it', () => {
  it('reads the family from /etc/os-release: ID, else what ID_LIKE names', () => {
    expect(parseOsRelease(osRelease({ ID: 'ubuntu', PRETTY_NAME: 'Ubuntu 24.04.1 LTS' }))).toEqual({
      family: 'debian',
      id: 'ubuntu',
      name: 'Ubuntu 24.04.1 LTS',
    });
    expect(parseOsRelease('ID=fedora\nNAME=Fedora Linux\n')).toMatchObject({
      family: 'fedora',
      name: 'Fedora Linux',
    });
    expect(parseOsRelease(osRelease({ ID: 'almalinux', ID_LIKE: 'rhel centos fedora' }))).toEqual({
      family: 'fedora',
      id: 'almalinux',
      name: 'almalinux',
    });
    expect(parseOsRelease(osRelease({ ID: 'rocky', ID_LIKE: 'rhel centos fedora' }))?.family).toBe(
      'fedora',
    );
    expect(
      parseOsRelease(osRelease({ ID: 'opensuse-tumbleweed', ID_LIKE: 'opensuse suse' }))?.family,
    ).toBe('suse');
    expect(parseOsRelease(osRelease({ ID: 'sles' }))?.family).toBe('suse');
    expect(parseOsRelease(osRelease({ ID: 'manjaro', ID_LIKE: 'arch' }))?.family).toBe('arch');
    expect(parseOsRelease('ID=alpine\n')?.family).toBe('alpine');
    expect(parseOsRelease(osRelease({ ID: 'linuxmint', ID_LIKE: 'ubuntu debian' }))?.family).toBe(
      'debian',
    );
    expect(parseOsRelease('ID=nixos\n')).toBeUndefined();
    expect(parseOsRelease('')).toBeUndefined();
  });

  it('currentHost reads it on Linux only', () => {
    const host = currentHost({}, () => 'ID=arch\nPRETTY_NAME="Arch Linux"\n');
    expect(host.distro).toEqual(
      process.platform === 'linux' ? { family: 'arch', id: 'arch', name: 'Arch Linux' } : undefined,
    );
    const unreadable = currentHost({}, () => {
      throw new Error('ENOENT');
    });
    expect(unreadable.distro).toBeUndefined();
  });

  it("installs a native build's tools with the distribution's package manager and names", () => {
    expect(installHint('linux', on('ID=debian\nPRETTY_NAME="Debian GNU/Linux 13"'))).toBe(
      'on Debian GNU/Linux 13: sudo apt-get install build-essential cmake meson ninja-build nasm pkg-config git curl autoconf automake libtool binutils patchelf xxd python3 gperf xz-utils diffutils',
    );
    expect(installHint('linux', on('ID=fedora\nNAME="Fedora Linux"'))).toBe(
      'on Fedora Linux: sudo dnf install gcc gcc-c++ make cmake meson ninja-build nasm pkgconf-pkg-config git curl autoconf automake libtool binutils patchelf perl vim-common python3 gperf xz diffutils',
    );
    expect(
      installHint('linux', on('ID=rocky\nID_LIKE="rhel centos fedora"\nNAME="Rocky Linux"')),
    ).toBe(
      'on Rocky Linux: sudo dnf install gcc gcc-c++ make cmake meson ninja-build nasm pkgconf-pkg-config git curl autoconf automake libtool binutils patchelf perl vim-common python3 gperf xz diffutils (meson, nasm and patchelf come from EPEL: sudo dnf install epel-release, and enable CRB, first)',
    );
    expect(
      installHint('linux', on('ID=opensuse-leap\nID_LIKE="suse opensuse"\nNAME="openSUSE Leap"')),
    ).toBe(
      'on openSUSE Leap: sudo zypper install gcc gcc-c++ make cmake meson ninja nasm pkg-config git curl autoconf automake libtool binutils patchelf perl vim python3 gperf xz diffutils',
    );
    expect(installHint('linux', on('ID=arch\nNAME="Arch Linux"'))).toBe(
      'on Arch Linux: sudo pacman -S --needed base-devel cmake meson ninja nasm git curl patchelf vim python gperf xz diffutils',
    );
    expect(installHint('linux', on('ID=alpine\nNAME="Alpine Linux"'))).toBe(
      'on Alpine Linux: sudo apk add build-base cmake meson samurai nasm pkgconf git curl autoconf automake libtool binutils patchelf perl bash xxd python3 gperf xz diffutils',
    );
  });

  it('names the packages of the tools only the Docker image had before: xxd, python3, gperf, xz, cmp, glslc', () => {
    const tools = ['xxd', 'python3', 'gperf', 'xz', 'cmp', 'glslc'];
    expect(nativeTools('linux', 'linux-x64')).toEqual(expect.arrayContaining(tools.slice(0, 5)));
    expect(nativeTools('windows', 'win-x64')).toEqual(expect.arrayContaining(tools.slice(0, 5)));
    expect(installHint('linux', on('ID=debian\nNAME=Debian'), tools)).toBe(
      'on Debian: sudo apt-get install xxd python3 gperf xz-utils diffutils glslc',
    );
    expect(installHint('linux', on('ID=fedora\nNAME=Fedora'), tools)).toBe(
      'on Fedora: sudo dnf install vim-common python3 gperf xz diffutils glslc',
    );
    expect(
      installHint('linux', on('ID=opensuse-leap\nID_LIKE="suse opensuse"\nNAME=Leap'), tools),
    ).toBe('on Leap: sudo zypper install vim python3 gperf xz diffutils shaderc');
    expect(installHint('linux', on('ID=arch\nNAME=Arch'), tools)).toBe(
      'on Arch: sudo pacman -S --needed vim python gperf xz diffutils shaderc',
    );
    expect(installHint('linux', on('ID=alpine\nNAME=Alpine'), tools)).toBe(
      'on Alpine: sudo apk add xxd python3 gperf xz diffutils shaderc',
    );
    expect(installHint('windows', win('MINGW64'))).toContain(
      'pacman -S --needed make git tar gzip curl autoconf automake libtool perl binutils vim python gperf xz diffutils mingw-w64-x86_64-gcc',
    );
    expect(installHint('windows', win('UCRT64'), ['glslc'])).toBe(
      'in the MSYS2 shell: pacman -S --needed mingw-w64-ucrt-x86_64-shaderc',
    );
  });

  it('installs only what is missing, when told what that is', () => {
    expect(
      installHint('linux', on('ID=ubuntu\nNAME=Ubuntu'), ['g++', 'ninja', 'gcc', 'strings']),
    ).toBe('on Ubuntu: sudo apt-get install build-essential ninja-build binutils');
    expect(
      installHint('linux', on('ID=fedora\nNAME=Fedora'), ['g++', 'pkg-config', 'libtoolize']),
    ).toBe('on Fedora: sudo dnf install gcc-c++ pkgconf-pkg-config libtool');
    expect(installHint('linux', on('ID=arch\nNAME=Arch'), ['make', 'gcc', 'ninja'])).toBe(
      'on Arch: sudo pacman -S --needed base-devel ninja',
    );
    expect(installHint('linux', on('ID=alpine\nNAME=Alpine'), ['ninja', 'g++'])).toBe(
      'on Alpine: sudo apk add samurai build-base',
    );
    // without a distribution it knows, the Debian line, as before
    expect(installHint('linux', linux, ['ninja'])).toBe(
      'on Debian/Ubuntu: sudo apt-get install ninja-build',
    );
    expect(installHint('linux', linux)).toBe(
      'on Debian/Ubuntu: sudo apt-get install build-essential cmake meson ninja-build nasm pkg-config git curl autoconf automake libtool binutils patchelf xxd python3 gperf xz-utils diffutils',
    );
  });

  it('installs and starts Docker the way this host does', () => {
    expect(dockerInstall(on('ID=ubuntu\nNAME=Ubuntu'))).toBe(
      'on Ubuntu: sudo apt-get install docker.io && sudo systemctl enable --now docker',
    );
    expect(dockerInstall(on('ID=fedora\nNAME=Fedora'))).toBe(
      'on Fedora: sudo dnf install moby-engine && sudo systemctl enable --now docker',
    );
    expect(dockerInstall(on('ID=almalinux\nID_LIKE="rhel centos fedora"\nNAME=AlmaLinux'))).toBe(
      'install Docker Engine for AlmaLinux: https://docs.docker.com/engine/install/',
    );
    expect(
      dockerInstall(on('ID=opensuse-tumbleweed\nID_LIKE="opensuse suse"\nNAME=Tumbleweed')),
    ).toBe('on Tumbleweed: sudo zypper install docker && sudo systemctl enable --now docker');
    expect(dockerInstall(on('ID=arch\nNAME=Arch'))).toBe(
      'on Arch: sudo pacman -S --needed docker && sudo systemctl enable --now docker',
    );
    expect(dockerInstall(on('ID=alpine\nNAME=Alpine'))).toBe(
      'on Alpine: sudo apk add docker && sudo rc-update add docker && sudo rc-service docker start',
    );
    expect(dockerInstall(linux)).toBe(
      'install Docker Engine: https://docs.docker.com/engine/install/',
    );
    expect(dockerInstall(win())).toBe(
      'install Docker Desktop (winget install Docker.DockerDesktop) and start it',
    );
    expect(dockerInstall({ os: 'darwin', arch: 'arm64', musl: false })).toBe(
      'install Docker Desktop (brew install --cask docker-desktop) and start it',
    );
    expect(dockerStart(win())).toBe('start Docker Desktop');
    expect(dockerStart({ os: 'darwin', arch: 'arm64', musl: false })).toBe('start Docker Desktop');
    expect(dockerStart(on('ID=ubuntu\nNAME=Ubuntu'))).toBe('sudo systemctl start docker');
    expect(dockerStart(on('ID=alpine\nNAME=Alpine'))).toBe('sudo rc-service docker start');
  });
});

describe('Git Bash is not MSYS2', () => {
  const gitBash: Host = { ...win('MINGW64'), gitBash: true };

  it("is found by MSYS2's pacman, not MSYSTEM (Git for Windows sets MSYSTEM too)", () => {
    const host = currentHost(
      { MSYSTEM: 'MINGW64' },
      () => '',
      () => false,
    );
    const msys2 = currentHost(
      { MSYSTEM: 'MINGW64' },
      () => '',
      () => true,
    );
    // only Windows asks
    expect(host.gitBash).toBe(process.platform === 'win32' ? true : undefined);
    expect(msys2.gitBash).toBeUndefined();
    expect(
      currentHost(
        {},
        () => '',
        () => false,
      ).gitBash,
    ).toBeUndefined();
  });

  it("can't build win-* natively, and says to use MSYS2", () => {
    expect(nativeKind('win-x64', gitBash)).toEqual({
      error:
        'win-x64 builds natively in an MSYS2 MINGW64 or UCRT64 or CLANG64 shell, and this is Git Bash (not MSYS2): install MSYS2 (winget install MSYS2.MSYS2) and run ffmpeg-build from that shell; or use --in docker',
    });
    expect(hostSummary(gitBash)).toBe('Windows x64, Git Bash (not MSYS2)');
  });
});

describe('this machine in a few words', () => {
  it('names the OS and CPU, and the distribution or MSYS2 environment', () => {
    expect(hostSummary(on('ID=ubuntu\nPRETTY_NAME="Ubuntu 24.04 LTS"'))).toBe(
      'Linux x64, Ubuntu 24.04 LTS',
    );
    expect(hostSummary({ ...linux, musl: true })).toBe('Linux (musl) x64');
    expect(hostSummary(win('UCRT64'))).toBe('Windows x64, MSYS2 UCRT64');
    expect(hostSummary(win())).toBe('Windows x64');
    expect(hostSummary({ os: 'darwin', arch: 'arm64', musl: false })).toBe('macOS arm64');
  });
});

describe('MSYS2', () => {
  it('picks the environment a Windows platform builds in: the shell it runs in when that one fits', () => {
    expect(msys2Environment('win-x64', win())).toBe('MINGW64');
    expect(msys2Environment('win-x64', win('UCRT64'))).toBe('UCRT64');
    expect(msys2Environment('win-x64', win('CLANG64'))).toBe('CLANG64');
    expect(msys2Environment('win-x64', win('CLANGARM64'))).toBe('MINGW64');
    expect(msys2Environment('win-arm64', win('MINGW64'))).toBe('CLANGARM64');
    expect(msys2Environment('win-arm64', win())).toBe('CLANGARM64');
    expect(msys2Environment('linux-x64', win())).toBeUndefined();
  });

  it("installs that environment's packages", () => {
    expect(installHint('windows', win('UCRT64'))).toContain('mingw-w64-ucrt-x86_64-gcc');
    expect(installHint('windows', win('CLANG64'))).toContain('mingw-w64-clang-x86_64-clang');
  });
});

describe('Homebrew', () => {
  it('reads the packages an Apple build needs from apple-brew.txt, without its comments', () => {
    expect(brewPackages('# tools\n#   brew install ...\nautoconf\n\nbash\n  cmake  \n')).toEqual([
      'autoconf',
      'bash',
      'cmake',
    ]);
  });
});
