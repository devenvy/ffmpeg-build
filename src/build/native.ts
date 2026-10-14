// Builds that run natively on the host instead of in a toolchain image: the macOS platforms (platforms.yml
// `image: macos`), which need Xcode. The Node worker runs them with their paths passed in the environment.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { BuildError } from './docker.ts';
import { DOCTOR_HINT } from './host.ts';
import { acquireLock, LockBusyError } from '../file-lock.ts';
import { toolchainIdentity } from './plan.ts';
import { toolchainFacts } from './toolchain.ts';

/**
 * Where native builds keep their libraries and scratch space: FFMPEG_BUILD_WORK (made absolute), else
 * ~/ffmpeg-build-work. No whitespace: the path ends up in FFmpeg's configure flags, CMake files and CFLAGS.
 */
export function nativeWorkRoot(): string {
  const root = resolve(
    (process.env['FFMPEG_BUILD_WORK'] ?? '') || join(homedir(), 'ffmpeg-build-work'),
  );
  if (/\s/.test(root)) {
    throw new BuildError(
      `the native build folder ${root} has a space in it; set FFMPEG_BUILD_WORK to a folder without spaces`,
    );
  }
  return root;
}

// What a native build inherits from the user's shell: nothing that steers compilers or search paths (CC, CPATH,
// LIBRARY_PATH, CMAKE_PREFIX_PATH, MAKEFLAGS, SDKROOT...), which would change what's built without changing the cache key.
const HOST_ENV =
  /^(HOME|USER|LOGNAME|TMPDIR|LANG|LC_[A-Z]+|TERM|PATH|SHELL|HOMEBREW_PREFIX|DEVELOPER_DIR)$/;
// Windows: what its programs need to start at all (SystemRoot, ...), and the MSYS2 shell the build runs in
const WINDOWS_ENV =
  /^(PATH|HOME|USERNAME|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|COMSPEC|PATHEXT|HOMEDRIVE|HOMEPATH|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|MSYSTEM|MSYSTEM_PREFIX|MSYSTEM_CARCH|MSYSTEM_CHOST|MINGW_PREFIX|MINGW_CHOST|MINGW_PACKAGE_PREFIX|LANG|TERM)$/i;

/**
 * The host environment a native build runs with: the allowlisted variables. On a Mac, Homebrew's bin first on PATH;
 * on Windows, what its programs need and the MSYS2 environment, PATH as it is (`;`-separated).
 */
export function hostEnv(
  env: NodeJS.ProcessEnv = process.env,
  os: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  const allowed = os === 'win32' ? WINDOWS_ENV : HOST_ENV;
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && allowed.test(k)) {
      out[k] = v;
    }
  }
  if (os === 'darwin') {
    const brew = `${(env['HOMEBREW_PREFIX'] ?? '') || '/opt/homebrew'}/bin`;
    out['PATH'] = [brew, ...(env['PATH'] ?? '').split(':').filter((p) => p && p !== brew)].join(
      ':',
    );
  }
  return out;
}

/**
 * One build per platform at a time on a machine: its deps folder is fixed and wiped at the start, so a second build
 * would rebuild under the first and poison the library cache. A lock whose process is gone is taken over (see
 * file-lock.ts). Returns the release function.
 */
export function acquireBuildLock(workRoot: string, platform: string): () => void {
  const path = join(workRoot, `${platform}.lock`);
  try {
    const held = acquireLock(path, `building ${platform}`);
    return () => held.release();
  } catch (e) {
    if (e instanceof LockBusyError) {
      throw new BuildError(
        `another ffmpeg-build is already building ${platform} on this machine${e.pid ? ` (pid ${e.pid})` : ''}; wait for it to finish`,
      );
    }
    throw e;
  }
}

/**
 * A platform's folders under the work root. The deps folder is fixed per platform because the libraries' .pc files
 * record it; it is wiped before each build, so one platform builds at a time on a host.
 */
export function nativePaths(workRoot: string, platform: string): { depsDir: string; work: string } {
  const posix = workRoot.replaceAll('\\', '/');
  return { depsDir: `${posix}/deps/${platform}`, work: `${posix}/work/${platform}` };
}

/** The environment the Node build worker reads its paths from (defaults are the container paths). */
export function nativeEnv(p: {
  plan: string;
  recipes: string;
  engine: string;
  cache: string;
  out: string;
  depsDir: string;
  work: string;
}): Record<string, string> {
  return {
    FFB_PLAN: p.plan,
    FFB_RECIPES: p.recipes,
    ENGINE: p.engine,
    FFB_CACHE: p.cache,
    FFB_OUT: p.out,
    DEPS_DIR: p.depsDir,
    FFB_WORK: p.work,
  };
}

/**
 * Before a native build: declared recipe shell steps need bash 4+ (macOS ships 3.2).
 */
export function nativePreflight(
  xcrun: () => void = () => {
    execFileSync('xcrun', ['--version'], { env: hostEnv(), stdio: 'ignore' });
  },
): void {
  try {
    xcrun();
  } catch {
    throw new BuildError(
      `an Apple build needs Xcode (xcode-select --install, or the Xcode app) and the Homebrew tools in platforms/apple-brew.txt (${DOCTOR_HINT})`,
    );
  }
}

/**
 * The host toolchain facts used in native cache keys: Xcode, SDK and pinned Homebrew tool versions.
 */
function setupFacts(engineRoot: string, setup: string, platform: string, depsDir: string): string {
  try {
    return toolchainFacts(engineRoot, setup, platform, depsDir, {
      ...hostEnv(),
      FFB_WORK: nativeWorkRoot(),
    });
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new BuildError(
      `couldn't read the ${setup} host toolchain: ${(err.stderr ?? err.message ?? '').trim() || 'it failed'}`,
    );
  }
}

/**
 * A native build's toolchain identity, the library cache's key part: the host toolchain the setup reports, the deps
 * folder the libraries are installed into, platform data and the Node toolchain modules.
 */
export function hostToolchainIdentity(
  engineRoot: string,
  setup: string,
  platform: string,
  depsDir: string,
): string {
  return toolchainIdentity(
    engineRoot,
    `host\0${setupFacts(engineRoot, setup, platform, depsDir)}\0${depsDir}`,
    setup,
  );
}
