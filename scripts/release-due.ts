// The nightly engine release: node scripts/release-due.ts
// Prints the next patch tag (v1.2.4 after v1.2.3) when anything the npm package ships changed since the newest vX.Y.Z
// tag on HEAD's history, and nothing otherwise. What ships is package.json's `files` (dist/ stands for src/, which it
// is compiled from, and the tsconfig that compiles it), the package.json fields an install reads, the build's scripts
// and compiler, and the reusable workflows consumers call at the major tag; docs (*.md) and everything else outside the
// package (tests, CI, scripts) don't count, so they never make every consumer's builds due. Minor and major releases are cut by hand.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { EXIT_USAGE } from '../src/cli-error.ts';
import { packageRoot } from '../src/paths.ts';

interface PackageJson {
  files?: string[];
  [field: string]: unknown;
}

/**
 * What makes the package, besides its files: the package.json fields an install reads, the scripts that build dist/
 * and the compiler they run (a TypeScript bump can change the emitted code; the other development tools can't).
 */
const PACKAGE_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'engines',
  'os',
  'cpu',
  'bin',
  'main',
  'exports',
  'type',
  'files',
  'scripts.prepare',
  'scripts.build',
  'devDependencies.typescript',
];
/** Files that build dist/ from src/. */
const BUILD_FILES = ['tsconfig.json', 'tsconfig.build.json'];
/** The reusable workflows consumers call at the major tag (@v1), which a release moves: they ship too. */
export const REUSABLE_WORKFLOWS = [
  '.github/workflows/build.yml',
  '.github/workflows/check.yml',
  '.github/workflows/automerge.yml',
  '.github/workflows/update-lock.yml',
  '.github/workflows/update-pin.yml',
];
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

const git = (dir: string, args: string[]): string =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

function newestRelease(dir: string): { tag: string; parts: number[] } | undefined {
  const tags = git(dir, ['tag', '--list', 'v*', '--merged', 'HEAD'])
    .split('\n')
    .flatMap((tag) => {
      const m = RELEASE_TAG.exec(tag);
      return m ? [{ tag, parts: [Number(m[1]), Number(m[2]), Number(m[3])] }] : [];
    });
  const byVersion = (a: number[], b: number[]): number =>
    a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
  return tags.sort((a, b) => byVersion(a.parts, b.parts)).at(-1);
}

/** Why the package changed since `tag`: the shipped files that differ, and the runtime fields that do. */
export function shippedChanges(dir: string, tag: string): string[] {
  const now = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
  const was = JSON.parse(git(dir, ['show', `${tag}:package.json`])) as PackageJson;
  const paths = (now.files ?? [])
    .map((f) => (f === 'dist' ? 'src' : f))
    .filter((f) => !f.endsWith('.md'));
  const files = paths.length
    ? git(dir, [
        'diff',
        '--name-only',
        tag,
        'HEAD',
        '--',
        ...paths,
        ...BUILD_FILES,
        ...REUSABLE_WORKFLOWS,
      ])
        .split('\n')
        .filter((f) => f && !f.endsWith('.md'))
    : [];
  const at = (pkg: PackageJson, field: string): unknown =>
    field
      .split('.')
      .reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], pkg);
  const fields = PACKAGE_FIELDS.filter(
    (field) => JSON.stringify(at(now, field)) !== JSON.stringify(at(was, field)),
  ).map((field) => `package.json ${field}`);
  return [...files, ...fields];
}

/** The tag the nightly release would cut, or undefined: nothing released yet, or nothing shipped changed. */
export function nextRelease(
  dir: string,
): { tag: string; since: string; why: string[] } | undefined {
  const last = newestRelease(dir);
  if (!last) {
    return undefined;
  }
  const why = shippedChanges(dir, last.tag);
  if (!why.length) {
    return undefined;
  }
  const [major, minor, patch] = last.parts;
  return { tag: `v${String(major)}.${String(minor)}.${String(patch! + 1)}`, since: last.tag, why };
}

if (import.meta.main) {
  try {
    const next = nextRelease(packageRoot);
    if (next) {
      process.stderr.write(`${next.tag}: since ${next.since}, ${next.why.join(', ')}\n`);
      process.stdout.write(`${next.tag}\n`);
    } else {
      process.stderr.write(
        'no release due: nothing the package ships changed (or nothing is released yet)\n',
      );
    }
  } catch (e) {
    process.stderr.write(`release-due: ${(e as Error).message}\n`);
    process.exit(EXIT_USAGE);
  }
}
