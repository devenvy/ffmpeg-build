// Native builds (--in here): which platforms this machine can build itself, the tools that needs, and the facts about
// them that make up the build's toolchain identity. Apple builds natively on a Mac (Xcode), a Linux machine builds its
// own Linux platform (glibc), and Windows builds win-* in MSYS2's MinGW environment. Everything else builds in Docker.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/** What an error about this machine's tools ends with: the command that checks them all, with install lines. */
export const DOCTOR_HINT = '`ffmpeg-build doctor` says what this machine needs';

/** A Linux distribution, by the package manager its family uses: apt-get, dnf, zypper, pacman or apk. */
type DistroFamily = 'debian' | 'fedora' | 'suse' | 'arch' | 'alpine';
export interface Distro {
  family: DistroFamily;
  id: string;
  name: string;
}

export interface Host {
  os: NodeJS.Platform;
  arch: string;
  musl: boolean;
  msystem?: string;
  /** MSYSTEM is set, but by Git for Windows' bash, not MSYS2: there is no MSYS2 toolchain here */
  gitBash?: true;
  distro?: Distro;
}

const readOsRelease = (): string => readFileSync('/etc/os-release', 'utf8');

/** Whether the shell MSYSTEM comes from is MSYS2: its root has pacman, which Git for Windows' doesn't. */
function hasPacman(): boolean {
  const r = spawnSync('cygpath', ['-w', '/usr/bin/pacman.exe'], { encoding: 'utf8' });
  // no cygpath at all: nothing to tell by, so MSYSTEM is believed
  return r.status !== 0 || existsSync(r.stdout.trim());
}

/** This machine: OS, CPU, libc and distribution (Linux), and the MSYS2 environment it runs in (Windows). */
export function currentHost(
  env: NodeJS.ProcessEnv = process.env,
  osRelease: () => string = readOsRelease,
  msys2: () => boolean = hasPacman,
): Host {
  const linux = process.platform === 'linux';
  const report = linux
    ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)
    : undefined;
  let distro: Distro | undefined;
  if (linux) {
    try {
      distro = parseOsRelease(osRelease());
    } catch {
      distro = undefined; // no /etc/os-release: the install hints fall back to Debian's
    }
  }
  return {
    os: process.platform,
    arch: process.arch,
    musl: linux && !report?.header?.glibcVersionRuntime,
    ...(env['MSYSTEM'] ? { msystem: env['MSYSTEM'] } : {}),
    ...(process.platform === 'win32' && env['MSYSTEM'] && !msys2()
      ? { gitBash: true as const }
      : {}),
    ...(distro ? { distro } : {}),
  };
}

// os-release IDs (the distribution's own, then what ID_LIKE says it resembles) and the family each belongs to
const FAMILIES: [RegExp, DistroFamily][] = [
  [/^(debian|ubuntu)$/, 'debian'],
  [/^(fedora|rhel|centos|almalinux|rocky|ol|amzn)$/, 'fedora'],
  [/^(opensuse.*|suse|sles)$/, 'suse'],
  [/^(arch|archarm|manjaro|endeavouros)$/, 'arch'],
  [/^alpine$/, 'alpine'],
];

/** The distribution /etc/os-release describes, when its family is one ffmpeg-build knows how to install on. */
export function parseOsRelease(text: string): Distro | undefined {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) {
      fields.set(m[1]!, m[2]!.replace(/^(["'])(.*)\1$/, '$2'));
    }
  }
  const id = fields.get('ID');
  if (!id) {
    return undefined;
  }
  for (const candidate of [id, ...(fields.get('ID_LIKE') ?? '').split(/\s+/).filter(Boolean)]) {
    const family = FAMILIES.find(([re]) => re.test(candidate))?.[1];
    if (family) {
      return { family, id, name: fields.get('PRETTY_NAME') ?? fields.get('NAME') ?? id };
    }
  }
  return undefined;
}

// MSYS2 environments that build each Windows platform natively
const MSYSTEM: Record<string, string[]> = {
  'win-x64': ['MINGW64', 'UCRT64', 'CLANG64'],
  'win-arm64': ['CLANGARM64'],
};
const PREFIX: Record<string, string> = {
  MINGW64: 'mingw-w64-x86_64',
  UCRT64: 'mingw-w64-ucrt-x86_64',
  CLANG64: 'mingw-w64-clang-x86_64',
  CLANGARM64: 'mingw-w64-clang-aarch64',
};

/** The native toolchain kind for a platform on this host, or why this host can't build it natively. */
export function nativeKind(
  platform: string,
  host: Host,
): { kind: 'apple' | 'linux' | 'windows' } | { error: string } {
  const elsewhere = (what: string) => ({
    error: `${platform} builds natively only ${what}; this machine is ${describe(host)} (use --in docker)`,
  });
  if (/^(osx|ios|maccatalyst)-/.test(platform)) {
    return host.os === 'darwin'
      ? { kind: 'apple' }
      : { error: `${platform} builds only on a Mac, with Xcode` };
  }
  if (platform === 'linux-x64' || platform === 'linux-arm64') {
    const arch = platform === 'linux-x64' ? 'x64' : 'arm64';
    return host.os === 'linux' && host.arch === arch && !host.musl
      ? { kind: 'linux' }
      : elsewhere(`on a ${platform} (glibc) machine`);
  }
  if (platform === 'win-x64' || platform === 'win-arm64') {
    if (host.os !== 'win32') {
      return elsewhere('on Windows, in MSYS2');
    }
    const wanted = MSYSTEM[platform]!;
    if (host.gitBash) {
      return {
        error: `${platform} builds natively in an MSYS2 ${wanted.join(' or ')} shell, and this is Git Bash (not MSYS2): install MSYS2 (winget install MSYS2.MSYS2) and run ffmpeg-build from that shell; or use --in docker`,
      };
    }
    if (!host.msystem || !wanted.includes(host.msystem)) {
      return {
        error: `${platform} builds natively in an MSYS2 ${wanted.join(' or ')} shell${host.msystem ? `, not ${host.msystem}` : ' (MSYSTEM is not set: run ffmpeg-build from that MSYS2 shell)'}; or use --in docker`,
      };
    }
    return { kind: 'windows' };
  }
  return {
    error: `${platform} builds only in Docker (--in here is for linux-x64, linux-arm64, win-* and Apple)`,
  };
}

function describe(host: Host): string {
  return `${osName(host)} ${host.arch}`;
}

/** This machine in a few words: OS and CPU, with the Linux distribution or the MSYS2 environment it runs in. */
export function hostSummary(host: Host): string {
  const shell = host.gitBash ? 'Git Bash (not MSYS2)' : `MSYS2 ${host.msystem ?? ''}`;
  const where = host.distro?.name ?? (host.msystem ? shell : undefined);
  return where ? `${describe(host)}, ${where}` : describe(host);
}

function osName(host: Host): string {
  if (host.os === 'win32') {
    return 'Windows';
  }
  if (host.os === 'darwin') {
    return 'macOS';
  }
  if (host.os === 'linux') {
    return `Linux${host.musl ? ' (musl)' : ''}`;
  }
  return host.os;
}

/** MSYS2's CLANG64/CLANGARM64 environments compile with clang; MINGW64/UCRT64 with gcc. */
const windowsClang = (platform: string, msystem?: string): boolean =>
  platform === 'win-arm64' || (msystem ?? '').startsWith('CLANG');

/** The commands a native build runs, beyond Node: compilers, build systems, and what fetching and staging use. */
export function nativeTools(
  kind: 'linux' | 'windows',
  platform: string,
  msystem?: string,
): string[] {
  const common = [
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
    // what the Docker images also install for the recipes: libvmaf's built-in models (xxd), shaderc's git-sync-deps
    // (python3), gperf, xz tarballs, and cmp in configure scripts
    'xxd',
    'python3',
    'gperf',
    'xz',
    'cmp',
  ];
  if (kind === 'linux') {
    return [...common, 'gcc', 'g++', 'patchelf'];
  }
  return [
    ...common,
    ...(windowsClang(platform, msystem) ? ['clang', 'clang++'] : ['gcc', 'g++']),
    'objdump',
    'gendef',
    'llvm-dlltool',
  ];
}

// The package that has each tool a native Linux build uses, per family: debian, fedora, suse, arch, alpine
const PACKAGES: Record<string, [string, string, string, string, string]> = {
  gcc: ['build-essential', 'gcc', 'gcc', 'base-devel', 'build-base'],
  'g++': ['build-essential', 'gcc-c++', 'gcc-c++', 'base-devel', 'build-base'],
  make: ['build-essential', 'make', 'make', 'base-devel', 'build-base'],
  ninja: ['ninja-build', 'ninja-build', 'ninja', 'ninja', 'samurai'],
  'pkg-config': ['pkg-config', 'pkgconf-pkg-config', 'pkg-config', 'base-devel', 'pkgconf'],
  libtoolize: ['libtool', 'libtool', 'libtool', 'base-devel', 'libtool'],
  strings: ['binutils', 'binutils', 'binutils', 'base-devel', 'binutils'],
  autoconf: ['autoconf', 'autoconf', 'autoconf', 'base-devel', 'autoconf'],
  automake: ['automake', 'automake', 'automake', 'base-devel', 'automake'],
  perl: ['perl', 'perl', 'perl', 'base-devel', 'perl'],
  docker: ['docker.io', 'moby-engine', 'docker', 'docker', 'docker'],
  xxd: ['xxd', 'vim-common', 'vim', 'vim', 'xxd'],
  python3: ['python3', 'python3', 'python3', 'python', 'python3'],
  xz: ['xz-utils', 'xz', 'xz', 'xz', 'xz'],
  cmp: ['diffutils', 'diffutils', 'diffutils', 'diffutils', 'diffutils'],
  glslc: ['glslc', 'glslc', 'shaderc', 'shaderc', 'shaderc'],
};
const FAMILY_INDEX: Record<DistroFamily, number> = {
  debian: 0,
  fedora: 1,
  suse: 2,
  arch: 3,
  alpine: 4,
};
// Everything a native Linux build needs, as each family installs it (Debian's is the line ffmpeg-build always gave;
// Debian, Ubuntu and Arch have bash, tar, gzip and perl in every install)
const ALL_PACKAGES: Record<DistroFamily, string> = {
  debian:
    'build-essential cmake meson ninja-build nasm pkg-config git curl autoconf automake libtool binutils patchelf xxd python3 gperf xz-utils diffutils',
  fedora:
    'gcc gcc-c++ make cmake meson ninja-build nasm pkgconf-pkg-config git curl autoconf automake libtool binutils patchelf perl vim-common python3 gperf xz diffutils',
  suse: 'gcc gcc-c++ make cmake meson ninja nasm pkg-config git curl autoconf automake libtool binutils patchelf perl vim python3 gperf xz diffutils',
  arch: 'base-devel cmake meson ninja nasm git curl patchelf vim python gperf xz diffutils',
  alpine:
    'build-base cmake meson samurai nasm pkgconf git curl autoconf automake libtool binutils patchelf perl bash xxd python3 gperf xz diffutils',
};
const INSTALL: Record<DistroFamily, string> = {
  debian: 'sudo apt-get install',
  fedora: 'sudo dnf install',
  suse: 'sudo zypper install',
  arch: 'sudo pacman -S --needed',
  alpine: 'sudo apk add',
};
/** RHEL and its rebuilds are dnf's family, but some build tools are only in EPEL there. */
const isRhelLike = (d: Distro): boolean => d.family === 'fedora' && d.id !== 'fedora';

/** The packages that have these tools on a distribution family, each once, in the tools' order. */
function packagesFor(tools: readonly string[], family: DistroFamily): string[] {
  return [...new Set(tools.map((t) => PACKAGES[t]?.[FAMILY_INDEX[family]] ?? t))];
}

/**
 * How to install what's missing: on Linux with the distribution's package manager (Debian's when it isn't one
 * ffmpeg-build knows), only the `missing` tools when given; on Windows, the MSYS2 environment's packages.
 */
export function installHint(
  kind: 'linux' | 'windows',
  host: Host,
  missing?: readonly string[],
): string {
  if (kind === 'linux') {
    const family = host.distro?.family ?? 'debian';
    const packages = missing ? packagesFor(missing, family).join(' ') : ALL_PACKAGES[family];
    const epel =
      host.distro && isRhelLike(host.distro)
        ? ' (meson, nasm and patchelf come from EPEL: sudo dnf install epel-release, and enable CRB, first)'
        : '';
    return `on ${host.distro?.name ?? 'Debian/Ubuntu'}: ${INSTALL[family]} ${packages}${epel}`;
  }
  const p = PREFIX[host.msystem ?? 'MINGW64'] ?? PREFIX['MINGW64']!;
  // glslc, needed only by Vulkan builds, is asked for on its own
  if (missing?.length === 1 && missing[0] === 'glslc') {
    return `in the MSYS2 shell: pacman -S --needed ${p}-shaderc`;
  }
  const compiler = host.msystem === 'CLANGARM64' || host.msystem === 'CLANG64' ? 'clang' : 'gcc';
  return `in the MSYS2 shell: pacman -S --needed make git tar gzip curl autoconf automake libtool perl binutils vim python gperf xz diffutils ${[compiler, 'cmake', 'meson', 'ninja', 'nasm', 'pkgconf', 'tools-git', 'llvm'].map((x) => `${p}-${x}`).join(' ')}`;
}

const DOCKER_DOCS = 'https://docs.docker.com/engine/install/';

/** How to install Docker here: Docker Desktop on Windows and macOS, the distribution's Docker Engine on Linux. */
export function dockerInstall(host: Host): string {
  if (host.os === 'win32') {
    return 'install Docker Desktop (winget install Docker.DockerDesktop) and start it';
  }
  if (host.os === 'darwin') {
    return 'install Docker Desktop (brew install --cask docker-desktop) and start it';
  }
  const d = host.distro;
  if (!d) {
    return `install Docker Engine: ${DOCKER_DOCS}`;
  }
  if (isRhelLike(d)) {
    return `install Docker Engine for ${d.name}: ${DOCKER_DOCS}`;
  }
  const start =
    d.family === 'alpine'
      ? 'sudo rc-update add docker && sudo rc-service docker start'
      : 'sudo systemctl enable --now docker';
  return `on ${d.name}: ${INSTALL[d.family]} ${packagesFor(['docker'], d.family).join(' ')} && ${start}`;
}

/** How to start Docker here once it is installed. */
export function dockerStart(host: Host): string {
  if (host.os !== 'linux') {
    return 'start Docker Desktop';
  }
  return host.distro?.family === 'alpine'
    ? 'sudo rc-service docker start'
    : 'sudo systemctl start docker';
}

/** The MSYS2 environment a Windows platform builds in here: the shell's own when it is one that can, else the usual. */
export function msys2Environment(platform: string, host: Host): string | undefined {
  const wanted = MSYSTEM[platform];
  if (!wanted) {
    return undefined;
  }
  return host.msystem && !host.gitBash && wanted.includes(host.msystem) ? host.msystem : wanted[0];
}

/** The Homebrew packages platforms/apple-brew.txt lists. */
export function brewPackages(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/** The tools a native build needs that this machine doesn't have (looked up with `command -v` in bash). */
export function missingTools(
  tools: readonly string[],
  env: NodeJS.ProcessEnv,
  lookup: (tool: string) => boolean = (tool) => onPath(tool, env),
): string[] {
  return tools.filter((t) => !lookup(t));
}

function onPath(tool: string, env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync('bash', ['-c', 'command -v "$1" >/dev/null', '_', tool], { env, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * What a native Linux or Windows build's output depends on, beyond the engine: the compiler and build tools' versions
 * (and, on Windows, the MSYS2 environment). Part of its toolchain identity, so a toolchain upgrade rebuilds the libraries.
 */
export function hostFacts(
  kind: 'linux' | 'windows',
  platform: string,
  env: NodeJS.ProcessEnv,
  version: (tool: string) => string = (tool) => firstLine(tool, env),
): string {
  const tools =
    kind === 'windows' && windowsClang(platform, env['MSYSTEM'])
      ? ['clang', 'clang++', 'ld']
      : ['gcc', 'g++', 'ld'];
  // every tool that shapes what's built: the compilers, the build systems, and the autotools that regenerate configure
  const lines = [
    ...tools,
    'cmake',
    'meson',
    'ninja',
    'nasm',
    'pkg-config',
    'make',
    'autoconf',
    'automake',
    'libtoolize',
  ].map((t) => `${t}: ${version(t)}`);
  if (kind === 'linux') {
    lines.push(`libc: ${version('ldd')}`);
  }
  if (kind === 'windows') {
    lines.push(`msystem: ${env['MSYSTEM'] ?? ''}`);
  }
  return `${lines.join('\n')}\n`;
}

function firstLine(tool: string, env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('bash', ['-c', '"$1" --version 2>&1 | head -1', '_', tool], {
      env,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}
