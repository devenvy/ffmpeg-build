// scripts/release-due.ts: the nightly engine release cuts the next patch only when what the package ships changed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nextRelease } from '../scripts/release-due.ts';

const pkg = (extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ name: 'x', version: '1.0.0', files: ['dist', 'recipes', 'docs/guide.md'], dependencies: { yaml: '2.9.1' }, ...extra }, null, 2)}\n`;

function repo(): {
  dir: string;
  commit: (files: Record<string, string>) => void;
  tag: (t: string) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-release-due-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  const commit = (files: Record<string, string>) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'change');
  };
  commit({ 'package.json': pkg(), 'src/cli.ts': 'a\n', 'recipes/x/recipe.yml': 'a\n' });
  return { dir, commit, tag: (t) => git('tag', t) };
}

describe('release-due', () => {
  it('cuts nothing before the first release, which is made by hand', () => {
    expect(nextRelease(repo().dir)).toBeUndefined();
  });

  it('cuts nothing when only docs, tests or CI changed', () => {
    const r = repo();
    r.tag('v1.0.0');
    r.commit({
      'README.md': 'x\n',
      'docs/guide.md': 'x\n',
      'tests/a.test.ts': 'x\n',
      '.github/workflows/ci.yml': 'x\n',
    });
    r.commit({ 'package.json': pkg({ devDependencies: { vitest: '5.0.3' } }) });
    expect(nextRelease(r.dir)).toBeUndefined();
  });

  it('cuts the next patch after the newest release when the code, the data or a runtime dependency changed', () => {
    const r = repo();
    r.tag('v1.0.9');
    r.tag('v1.0.10');
    r.tag('v1.1.0-rc.1');
    r.commit({ 'src/cli.ts': 'b\n' });
    expect(nextRelease(r.dir)).toEqual({ tag: 'v1.0.11', since: 'v1.0.10', why: ['src/cli.ts'] });

    r.tag('v1.0.11');
    r.commit({
      'recipes/x/recipe.yml': 'b\n',
      'package.json': pkg({ dependencies: { yaml: '2.9.2' } }),
    });
    expect(nextRelease(r.dir)?.why).toEqual(['recipes/x/recipe.yml', 'package.json dependencies']);
  });

  it('counts what builds dist/: the tsconfig, the build scripts and the compiler, but not other tools', () => {
    const r = repo();
    r.tag('v1.0.0');
    r.commit({
      'package.json': pkg({ scripts: { lint: 'eslint .' }, devDependencies: { eslint: '10' } }),
    });
    expect(nextRelease(r.dir)).toBeUndefined();
    r.commit({ 'tsconfig.build.json': '{}\n' });
    expect(nextRelease(r.dir)?.why).toEqual(['tsconfig.build.json']);
    r.tag('v1.0.1');
    r.commit({
      'package.json': pkg({
        scripts: { lint: 'eslint .', prepare: 'tsc' },
        devDependencies: { eslint: '10', typescript: '6.0.3' },
        exports: './dist/cli.js',
      }),
    });
    expect(nextRelease(r.dir)?.why).toEqual([
      'package.json exports',
      'package.json scripts.prepare',
      'package.json devDependencies.typescript',
    ]);
  });

  it('ignores release tags that are not on HEAD', () => {
    const r = repo();
    r.tag('v1.0.0');
    r.commit({ 'src/cli.ts': 'b\n' });
    execFileSync('git', ['tag', 'v1.5.0', 'HEAD~1'], { cwd: r.dir });
    execFileSync('git', ['checkout', '-q', '-b', 'old', 'HEAD~1'], { cwd: r.dir });
    execFileSync('git', ['tag', '-d', 'v1.5.0'], { cwd: r.dir });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: r.dir });
    expect(nextRelease(r.dir)?.tag).toBe('v1.0.1');
  });
});
