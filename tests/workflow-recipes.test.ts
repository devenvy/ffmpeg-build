// recipes.yml: what changed since the push's or pull request's base, which decides the recipes it builds.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { gitBash } from '../src/commands/test.ts';
import { packageRoot } from '../src/paths.ts';

interface Workflow {
  jobs: Record<string, { needs?: string[]; steps?: { id?: string; run?: string }[] }>;
}

const bash = process.platform === 'win32' ? gitBash() : 'bash';
const read = (file: string) =>
  parse(readFileSync(join(packageRoot, '.github', 'workflows', file), 'utf8')) as Workflow;
const diff = read('recipes.yml').jobs['changed']!.steps!.find((s) => s.id === 'diff')!;

describe.skipIf(!bash)("recipes.yml's changed recipes", () => {
  /** A repository of `commits` commits, each adding recipes/lib<i>; then `after` runs on it. */
  const changed = (
    commits: number,
    after?: (dir: string, git: (...a: string[]) => void) => void,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-recipes-'));
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    };
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    for (let i = 1; i <= commits; i++) {
      mkdirSync(join(dir, 'recipes', `lib${String(i)}`), { recursive: true });
      writeFileSync(join(dir, 'recipes', `lib${String(i)}`, 'recipe.yml'), 'x\n');
      git('add', '-A');
      git('commit', '-q', '-m', `c${String(i)}`);
    }
    after?.(dir, git);
    const output = join(dir, 'output');
    writeFileSync(output, '');
    const r = spawnSync(bash!, ['-e', '-c', diff.run!], {
      cwd: dir,
      encoding: 'utf8',
      // a push that created the branch: GitHub's `before` is all zeros
      env: { ...process.env, BASE: '0'.repeat(40), RUNNER_TEMP: dir, GITHUB_OUTPUT: output },
    });
    expect(r.status, r.stderr).toBe(0);
    return {
      files: readFileSync(join(dir, 'changed'), 'utf8').trim().split('\n'),
      recipes: /^recipes=(.*)$/m.exec(readFileSync(output, 'utf8'))![1],
      stderr: r.stderr,
    };
  };

  it('takes the commit before when the base is unknown', () => {
    expect(changed(2).files).toEqual(['recipes/lib2/recipe.yml']);
    expect(changed(2).recipes).toBe('lib2');
  });

  it("counts every file of a repository's first commit, which has none before it", () => {
    expect(changed(1).files).toEqual(['recipes/lib1/recipe.yml']);
  });

  it('leaves out a recipe that was removed', () => {
    const r = changed(1, (dir, git) => {
      mkdirSync(join(dir, 'recipes', 'kept'));
      writeFileSync(join(dir, 'recipes', 'kept', 'recipe.yml'), 'y\n');
      rmSync(join(dir, 'recipes', 'lib1'), { recursive: true });
      git('add', '-A');
      git('commit', '-q', '-m', 'swap');
    });
    expect(r.recipes).toBe('kept');
    expect(r.stderr).toContain('recipes/lib1 is gone');
  });
});

describe('the recipe check is part of the required check', () => {
  it('ci.yml calls recipes.yml, and result needs it', () => {
    const ci = read('ci.yml');
    expect(ci.jobs['recipes']).toMatchObject({ uses: './.github/workflows/recipes.yml' });
    expect(ci.jobs['result']!.needs).toContain('recipes');
  });
});
