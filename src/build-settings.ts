// ffmpeg-build.yml's build: section: where each platform's targets build (runner: a GitHub runs-on label, or a list
// of labels) and how (in: docker, the pinned image; here, natively on that machine). Keyed by platform pattern; later
// entries override earlier ones, key by key. Without it, platforms.yml's runners and the platform's usual way apply.
import { platformMatches } from './platforms.ts';

import type { Folder } from './targets.ts';

export type BuildIn = 'docker' | 'here';
export interface BuildSettings {
  runner?: string | string[];
  in?: BuildIn;
}
export interface BuildSettingEntry extends BuildSettings {
  pattern: string;
}

const APPLE = /^(osx|ios|maccatalyst)-/;
export const isApple = (platform: string): boolean => APPLE.test(platform);

/** What the build: section says for a platform: every matching entry, in order, later keys winning. */
export function buildSettings(folder: Pick<Folder, 'build'>, platform: string): BuildSettings {
  const out: BuildSettings = {};
  for (const e of folder.build.filter((entry) => platformMatches(platform, [entry.pattern]))) {
    if (e.runner !== undefined) {
      out.runner = e.runner;
    }
    if (e.in !== undefined) {
      out.in = e.in;
    }
  }
  return out;
}

/** How a platform builds when nothing says otherwise: Apple natively on a Mac, everything else in its Docker image. */
export const defaultIn = (platform: string): BuildIn => (isApple(platform) ? 'here' : 'docker');

type Os = 'linux' | 'macos' | 'windows';
interface Machine {
  os: Os;
  arch?: 'x64' | 'arm64';
}

/** The machine a runs-on value names, when it is a GitHub-hosted label (or self-hosted labels saying OS and arch). */
function machineOf(runner: string | string[]): Machine | undefined {
  const labels = typeof runner === 'string' ? [runner] : runner;
  if (labels.length === 1) {
    const l = labels[0]!;
    if (l.startsWith('ubuntu-')) {
      return { os: 'linux', arch: l.endsWith('-arm') ? 'arm64' : 'x64' };
    }
    if (l.startsWith('windows-')) {
      return { os: 'windows', arch: l.endsWith('-arm') ? 'arm64' : 'x64' };
    }
    if (l.startsWith('macos-')) {
      return { os: 'macos', arch: l.endsWith('-intel') || l.endsWith('-large') ? 'x64' : 'arm64' };
    }
    return undefined;
  }
  const os = labels
    .map((l) => l.toLowerCase())
    .find((l): l is Os => l === 'linux' || l === 'macos' || l === 'windows');
  if (!os) {
    return undefined;
  }
  const arch = labels
    .map((l) => l.toLowerCase())
    .find((l): l is NonNullable<Machine['arch']> => l === 'x64' || l === 'arm64');
  return { os, ...(arch ? { arch } : {}) };
}

const show = (runner: string | string[]) =>
  typeof runner === 'string' ? runner : runner.join(', ');
const NATIVE = 'linux-x64, linux-arm64, win-* and Apple';
/** How a platform name starts for each OS. */
const PLATFORM_OS: Record<Os, string> = { windows: 'win', macos: 'osx', linux: 'linux' };

/** The machine an in: here build of a platform needs, or undefined when the platform builds only in Docker. */
function nativeMachine(platform: string): Machine | undefined {
  if (platform === 'linux-x64') {
    return { os: 'linux', arch: 'x64' };
  }
  if (platform === 'linux-arm64') {
    return { os: 'linux', arch: 'arm64' };
  }
  return platform.startsWith('win-') ? { os: 'windows' } : undefined;
}

/**
 * What can't work, before anything builds: Apple off a Mac or in Docker, Docker off Linux, a native (here) build for
 * another machine, or for a platform that only builds in Docker. A runner it can't read is trusted, with a note.
 */
export function buildSettingProblems(
  platform: string,
  settings: BuildSettings,
  defaultRunner = 'ubuntu-24.04',
): { errors: string[]; notes: string[] } {
  const errors: string[] = [];
  const notes: string[] = [];
  const how = settings.in ?? defaultIn(platform);
  const runner = settings.runner ?? defaultRunner;
  const machine = machineOf(runner);
  if (isApple(platform)) {
    if (how === 'docker') {
      errors.push(`${platform}: Apple builds run natively on a Mac; drop in: docker`);
    }
    if (settings.runner !== undefined && machine && machine.os !== 'macos') {
      errors.push(`${platform}: Apple builds need a macOS runner, not ${show(runner)}`);
    } else if (settings.runner !== undefined && !machine) {
      notes.push(
        `${platform}: runner ${show(runner)} is trusted to be a Mac (ffmpeg-build can only check GitHub-hosted labels)`,
      );
    }
    return { errors, notes };
  }
  if (how === 'docker') {
    if (machine && machine.os !== 'linux') {
      errors.push(
        `${platform}: a Docker build needs a Linux runner (${show(runner)} can't run the Linux images)${platform.startsWith('win-') && machine.os === 'windows' ? '; use in: here for a native build there' : ''}`,
      );
    } else if (!machine) {
      notes.push(
        `${platform}: runner ${show(runner)} is trusted to run Docker with Linux images (ffmpeg-build can only check GitHub-hosted labels)`,
      );
    }
    return { errors, notes };
  }
  // in: here builds for the machine it runs on
  const wanted = nativeMachine(platform);
  if (!wanted) {
    errors.push(`${platform}: builds only in Docker (in: here is for ${NATIVE})`);
    return { errors, notes };
  }
  if (!machine) {
    notes.push(
      `${platform}: runner ${show(runner)} is trusted to build ${platform} natively (ffmpeg-build can only check GitHub-hosted labels)`,
    );
  } else if (
    machine.os !== wanted.os ||
    (wanted.arch && machine.arch && machine.arch !== wanted.arch)
  ) {
    errors.push(
      `${platform}: in: here builds for the runner it runs on, and ${show(runner)} is ${PLATFORM_OS[machine.os]}-${machine.arch ?? 'x64'}`,
    );
  }
  return { errors, notes };
}

/**
 * What of the build: settings belongs in a target's toolchain identity: a native build depends on the machine (so
 * `here` and its runner count); a Docker build is the same wherever it runs (only `in` counts, and docker is the usual).
 */
export function settingsIdentity(platform: string, settings: BuildSettings): string | undefined {
  const how = settings.in ?? defaultIn(platform);
  if (how === defaultIn(platform) && (how === 'docker' || settings.runner === undefined)) {
    return undefined;
  }
  return JSON.stringify(
    how === 'here' ? { in: how, runner: settings.runner ?? null } : { in: how },
  );
}
