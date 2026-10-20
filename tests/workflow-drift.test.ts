// A repository calls ffmpeg-build's reusable workflows at a pinned release (Dependabot moves the pin weekly), while
// update-lock moves ffmpeg.lock's engine daily. Any 0.x engine runs on the @v0 workflows, so the two differing is no
// error, but an engine newer than its workflows runs without what they'd now give it: check says so, never fails.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { workflowPinNotes } from '../src/workflow-pins.ts';

const SHA = 'f8b45a38a7b7b63f2697a45ee608103f24c874ea';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** A repository (a .git folder) with these workflow files, and a build folder in it. */
function repo(workflows: Record<string, string>, folder = '.'): string {
  const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-pins-'));
  dirs.push(root);
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  for (const [name, text] of Object.entries(workflows)) {
    writeFileSync(join(root, '.github', 'workflows', name), text);
  }
  mkdirSync(join(root, folder), { recursive: true });
  return join(root, folder);
}

const job = (file: string, ref: string, comment = '') =>
  `jobs:\n  x:\n    uses: devenvy/ffmpeg-build/.github/workflows/${file}@${ref}${comment}\n`;

describe('the workflows a repository calls, against its lock', () => {
  it('notes each workflow file pinned to another release than the engine ffmpeg.lock records', () => {
    const dir = repo({
      'release.yml': job('build.yml', SHA, ' # v0.0.9'),
      'ci.yml':
        job('check.yml', SHA, ' # v0.0.12') +
        job('automerge.yml', 'v0.0.11').replace('jobs:\n', ''),
      'codeql.yml': 'jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v5\n',
    });
    expect(workflowPinNotes(dir, '0.0.12', {})).toEqual([
      "note: .github/workflows/ci.yml calls ffmpeg-build's automerge.yml at v0.0.11, but ffmpeg.lock's engine is 0.0.12: any 0.x engine runs on the @v0 workflows, but they are its own only at v0.0.12 (Dependabot moves the pin; or set it by hand)",
      "note: .github/workflows/release.yml calls ffmpeg-build's build.yml at v0.0.9, but ffmpeg.lock's engine is 0.0.12: any 0.x engine runs on the @v0 workflows, but they are its own only at v0.0.12 (Dependabot moves the pin; or set it by hand)",
    ]);
  });

  it('is a GitHub warning on a GitHub Actions run, on the file', () => {
    const dir = repo({ 'release.yml': job('build.yml', SHA, ' # v0.0.9') });
    expect(workflowPinNotes(dir, '0.0.12', { GITHUB_ACTIONS: 'true' })).toEqual([
      "::warning file=.github/workflows/release.yml,title=ffmpeg-build workflows behind the engine::.github/workflows/release.yml calls ffmpeg-build's build.yml at v0.0.9, but ffmpeg.lock's engine is 0.0.12: any 0.x engine runs on the @v0 workflows, but they are its own only at v0.0.12 (Dependabot moves the pin; or set it by hand)",
    ]);
  });

  it('says nothing when it can tell no release: a major tag, a branch, a bare commit, no repository', () => {
    const dir = repo(
      {
        'a.yml': job('build.yml', 'v0'),
        'b.yaml': job('build.yml', 'main'),
        'c.yml': job('build.yml', SHA),
        'd.yml': job('build.yml', SHA, ' # v0.0.12'),
      },
      'builds/linux',
    );
    expect(workflowPinNotes(dir, '0.0.12', {})).toEqual([]);
    const loose = mkdtempSync(join(tmpdir(), 'ffmpeg-build-pins-'));
    dirs.push(loose);
    expect(workflowPinNotes(loose, '0.0.12', {})).toEqual([]);
  });
});
