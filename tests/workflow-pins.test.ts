// Every external action the workflows (and the copy-ready examples) use is pinned by full commit SHA, with its version
// in a trailing comment for people and Dependabot: a tag can be moved to other code, a commit can't. Exempt: local
// `./` paths, and in the examples the engine's own reusable workflows at their major tag, which release.yml moves.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { packageRoot, packageVersion } from '../src/paths.ts';

interface Workflow {
  jobs?: Record<string, { uses?: string; steps?: { uses?: string }[] }>;
}

const folders = [
  ['.github', 'workflows'],
  ['examples', 'workflows'],
] as const;
const files = folders.flatMap((f) =>
  readdirSync(join(packageRoot, ...f))
    .filter((n) => /\.ya?ml$/.test(n))
    .map((n) => ({
      rel: `${f.join('/')}/${n}`,
      example: f[0] === 'examples',
      path: join(packageRoot, ...f, n),
    })),
);

// the engine's repository, as package.json names it
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  repository: { url: string };
};
const repo = /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(pkg.repository.url)![1]!;
const major = packageVersion().split('.')[0]!;
const isEngine = (uses: string): boolean =>
  uses.startsWith(`${repo}/.github/workflows/`) && uses.endsWith(`.yml@v${major}`);
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;

describe('action pins', () => {
  it('finds the workflows', () => {
    expect(files.some((f) => f.rel === '.github/workflows/build.yml')).toBe(true);
    expect(files.some((f) => f.example)).toBe(true);
  });

  for (const f of files) {
    it(`${f.rel}: every external action by full commit SHA, its version in a comment`, () => {
      const text = readFileSync(f.path, 'utf8');
      const w = parse(text) as Workflow;
      const uses = Object.values(w.jobs ?? {})
        .flatMap((j) => [j.uses, ...(j.steps ?? []).map((s) => s.uses)])
        .filter((u): u is string => Boolean(u));
      const external = uses.filter((u) => !u.startsWith('./') && !(f.example && isEngine(u)));
      expect(external.filter((u) => !PINNED.test(u))).toEqual([]);
      for (const u of external) {
        const line = text.split('\n').find((l) => l.includes(`uses: ${u}`))!;
        expect(line, u).toMatch(/ # v\d+\.\d+\.\d+$/);
      }
    });
  }

  it("the engine's own workflows never call the engine by tag", () => {
    for (const f of files.filter((x) => !x.example)) {
      const w = parse(readFileSync(f.path, 'utf8')) as Workflow;
      const uses = Object.values(w.jobs ?? {})
        .flatMap((j) => [j.uses, ...(j.steps ?? []).map((s) => s.uses)])
        .filter(Boolean);
      expect(
        uses.filter((u) => isEngine(u!)),
        f.rel,
      ).toEqual([]);
    }
  });

  it('Dependabot keeps the pins current', () => {
    const d = parse(readFileSync(join(packageRoot, '.github', 'dependabot.yml'), 'utf8')) as {
      updates: { 'package-ecosystem': string; directory: string }[];
    };
    expect(d.updates).toContainEqual(
      expect.objectContaining({ 'package-ecosystem': 'github-actions', directory: '/' }),
    );
  });
});
