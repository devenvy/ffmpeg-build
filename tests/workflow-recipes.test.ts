// recipes.yml: what changed since the push's or pull request's base, which decides the recipes it builds.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { gitBash } from '../src/commands/test.ts';
import { packageRoot } from '../src/paths.ts';

interface Workflow {
  jobs: Record<string, { steps?: { id?: string; run?: string }[] }>;
}

const bash = process.platform === 'win32' ? gitBash() : 'bash';
const plan = (
  parse(readFileSync(join(packageRoot, '.github', 'workflows', 'recipes.yml'), 'utf8')) as Workflow
).jobs['changed']!.steps!.find((s) => s.id === 'plan')!;
// the lines up to the diff: what changed, before the plan reads it
const diffLines = plan
  .run!.split('\n')
  .slice(0, plan.run!.split('\n').findIndex((l) => l.startsWith('git diff')) + 1);

describe.skipIf(!bash)("recipes.yml's changed files", () => {
  const changed = (commits: number): string[] => {
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
    const r = spawnSync(bash!, ['-e', '-c', diffLines.join('\n')], {
      cwd: dir,
      encoding: 'utf8',
      // a push that created the branch: GitHub's `before` is all zeros
      env: { ...process.env, BASE: '0'.repeat(40), RUNNER_TEMP: dir },
    });
    expect(r.status, r.stderr).toBe(0);
    return readFileSync(join(dir, 'changed'), 'utf8').trim().split('\n');
  };

  it('takes the commit before when the base is unknown', () => {
    expect(changed(2)).toEqual(['recipes/lib2/recipe.yml']);
  });

  it("counts every file of a repository's first commit, which has none before it", () => {
    expect(changed(1)).toEqual(['recipes/lib1/recipe.yml']);
  });
});
