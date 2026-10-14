import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type EngineData, loadEngineData } from '../src/engine-data.ts';

export const fixtureEngineRoot = fileURLToPath(new URL('./fixtures/engine', import.meta.url));
export const fixtureProfilesDir = fileURLToPath(new URL('./fixtures/profiles', import.meta.url));

export function fixtureData(): EngineData {
  return loadEngineData(fixtureEngineRoot);
}

/** A throwaway engine root: keys are paths like 'ffmpeg/9.yml', values are file contents. */
const DEFAULT_FFMPEG_SOURCE =
  "git: https://example.com/ffmpeg.git\nversions: { git-tags: '^n(\\d+\\.\\d+(?:\\.\\d+)?)$' }\nurl: https://example.com/ffmpeg-{version}.tar.xz\n";

const DEFAULT_LICENSES = [
  'licenses:',
  '  MIT: all',
  '  BSD-2-Clause: all',
  '  LGPL-2.0-or-later: all',
  '  GPL-2.0-or-later: [gplv2, gplv3, nonfree]',
  '  Apache-2.0: [lgplv3, gplv3, nonfree]',
  '',
].join('\n');

const DEFAULT_PLATFORMS = [
  'platforms:',
  '  linux-x64: { image: linux-x64, setup: linux, configure: [--enable-pthreads] }',
  '',
].join('\n');

/**
 * A recipe.yml with a `license:` line but no `license-files:` gets `license-files: [COPYING]` (every recipe needs
 * one; the tests that aren't about licence files don't spell it out).
 */
function withLicenseFiles(path: string, content: string): string {
  if (!/^recipes\/[^/]+\/recipe\.yml$/.test(path) || content.includes('license-files')) {
    return content;
  }
  return content.replace(/^(license: .*\n)/m, '$1license-files: [COPYING]\n');
}

function withBuild(path: string, content: string): string {
  if (!/^recipes\/[^/]+\/recipe\.yml$/.test(path) || /^build:/m.test(content)) {
    return content;
  }
  return `${content.replace(/\s*$/, '\n')}build: { system: none, steps: [['true']] }\n`;
}

export function writeEngine(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-engine-'));
  mkdirSync(join(root, 'ffmpeg'));
  mkdirSync(join(root, 'recipes'));
  for (const [path, content] of Object.entries({
    'ffmpeg/source.yml': DEFAULT_FFMPEG_SOURCE,
    'licenses.yml': DEFAULT_LICENSES,
    'platforms.yml': DEFAULT_PLATFORMS,
    ...files,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), withBuild(path, withLicenseFiles(path, content)));
  }
  return root;
}

/** studio.yml with its patch set, into `dir`: the profile's patches: path is relative to its folder. */
/** The studio fixture as targets: ffmpeg-build.yml and its patches. */
export function copyStudioFolder(dir: string): void {
  cpSync(
    join(fixtureProfilesDir, '..', 'folder', 'ffmpeg-build.yml'),
    join(dir, 'ffmpeg-build.yml'),
  );
  cpSync(join(fixtureProfilesDir, 'patches'), join(dir, 'patches'), { recursive: true });
  cpSync(join(fixtureProfilesDir, 'tests'), join(dir, 'tests'), { recursive: true });
}

export function copyStudio(dir: string): void {
  cpSync(join(fixtureProfilesDir, 'studio.yml'), join(dir, 'studio.yml'));
  cpSync(join(fixtureProfilesDir, 'patches'), join(dir, 'patches'), { recursive: true });
  cpSync(join(fixtureProfilesDir, 'tests'), join(dir, 'tests'), { recursive: true });
}

/** Runs the CLI from source, as a user would; stdout and stderr together on failure. */
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** What a CLI run printed and how it exited; `stdout` holds stderr too when it failed. */
export interface CliResult {
  stdout: string;
  out: string;
  err: string;
  exitCode: number;
}

export function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      encoding: 'utf8',
    });
    return { stdout, out: stdout, err: '', exitCode: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; status: number };
    return {
      stdout: err.stdout + err.stderr,
      out: err.stdout,
      err: err.stderr,
      exitCode: err.status,
    };
  }
}

/** A stand-in MSYS2 environment: its prefix holds winpthreads' licence, and cygpath answers with the prefix. */
export function msys2(extra: NodeJS.ProcessEnv = {}): {
  env: NodeJS.ProcessEnv;
  command: (c: string, a: string[]) => string;
  notice: string;
} {
  const prefix = mkdtempSync(join(tmpdir(), 'ffmpeg-build-msys2-')).replaceAll('\\', '/');
  mkdirSync(`${prefix}/share/licenses/winpthreads`, { recursive: true });
  writeFileSync(`${prefix}/share/licenses/winpthreads/COPYING`, 'MIT');
  return {
    env: { MINGW_PREFIX: '/mingw64', ...extra },
    command: (c) => (c === 'cygpath' ? prefix : ''),
    notice: `${prefix}/share/licenses/winpthreads/COPYING`,
  };
}
