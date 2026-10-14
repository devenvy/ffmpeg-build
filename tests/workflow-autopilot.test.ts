// A consumer on autopilot: update PRs opened as a GitHub App (so they start CI and code scanning like any other PR),
// one required check in the example CI, and automerge that waits for required checks instead of giving up.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { gitBash } from '../src/commands/test.ts';
import { packageRoot } from '../src/paths.ts';

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  if?: string;
  uses?: string;
  steps?: Step[];
}
interface Workflow {
  on: { workflow_call?: { inputs?: Record<string, unknown>; secrets?: Record<string, unknown> } };
  jobs: Record<string, Job>;
}

const read = (...path: string[]): Workflow =>
  parse(readFileSync(join(packageRoot, ...path), 'utf8')) as Workflow;
const bash = process.platform === 'win32' ? gitBash() : 'bash';

describe.each(['update-lock.yml', 'update-pin.yml'])('%s as a GitHub App', (file) => {
  const w = read('.github', 'workflows', file);
  const steps = Object.values(w.jobs).flatMap((j) => j.steps ?? []);

  it('takes the app as an input and a secret, both optional', () => {
    expect(w.on.workflow_call?.inputs).toHaveProperty('app-client-id');
    expect(w.on.workflow_call?.secrets).toHaveProperty('app-private-key');
    const app = steps.find((s) => s.id === 'app')!;
    expect(app.if).toBe("inputs.app-client-id != ''");
    expect(app.uses).toMatch(/^actions\/create-github-app-token@[0-9a-f]{40}$/);
  });

  it('checks out without keeping a write credential: the engine it installs and runs never sees one', () => {
    const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with?.['persist-credentials']).toBe(false);
    expect(checkout.with).not.toHaveProperty('token');
  });

  it('pushes and opens the PR with the app token when there is one, and then dispatches no CI', () => {
    const pushing = steps.find((s) => s.name === 'open or refresh the pull request')!;
    expect(pushing.run).toContain(`git push --force "\${remote}" "HEAD:refs/heads/\${BRANCH}"`);
    expect(pushing.run).toContain(`remote="https://x-access-token:\${GH_TOKEN}@`);
    const pr = steps.find((s) => s.name === 'open or refresh the pull request')!;
    expect(pr.env?.['GH_TOKEN']).toBe(
      `\${{ steps.app.outputs.token || secrets.token || github.token }}`,
    );
    expect(pr.env?.['HAS_TOKEN']).toBe(
      `\${{ steps.app.outputs.token != '' || secrets.token != '' }}`,
    );
  });
});

describe('the example CI', () => {
  const ci = read('examples', 'workflows', 'ci.yml');

  it('has one check to require, and merges only after it', () => {
    expect(ci.jobs['result']?.if).toBe('always()');
    expect(ci.jobs['result']?.needs).toBe('build');
    expect(ci.jobs['merge']?.needs).toBe('result');
  });
});

describe.skipIf(!bash)("automerge.yml's merge", () => {
  const step = read('.github', 'workflows', 'automerge.yml').jobs['merge']!.steps!.find(
    (s) => s.name === 'merge the labelled pull request the run tested',
  )!;

  /** The gh calls the step makes when a plain merge is refused `refused` (required checks still running). */
  const merges = (refused: boolean): string[] => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-automerge-'));
    const log = join(dir, 'log').replaceAll('\\', '/');
    writeFileSync(
      join(dir, 'gh'),
      [
        '#!/usr/bin/env bash',
        `echo "$*" >> "${log}"`,
        '[ "$1 $2" = "pr list" ] && echo "7 abc123" && exit 0',
        `[ "$1 $2" = "pr merge" ] && [ "$4" != --auto ] && exit ${refused ? '1' : '0'}`,
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const r = spawnSync(bash!, ['-e', '-c', step.run!], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BRANCH: 'ffmpeg-build/update-lock/root',
        SHA: 'abc123',
        LABEL: 'ffmpeg-build:automerge',
        GITHUB_STEP_SUMMARY: join(dir, 'summary'),
        PATH: `${dir}${delimiter}${process.env['PATH'] ?? ''}`,
      },
    });
    expect(r.status, r.stderr).toBe(0);
    return readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter((c) => c.startsWith('pr merge'));
  };

  it('merges at once when it can', () => {
    expect(merges(false)).toEqual(['pr merge 7 --squash --match-head-commit abc123']);
  });

  it('leaves it to GitHub to merge once the required checks pass, when they are still running', () => {
    expect(merges(true)).toEqual([
      'pr merge 7 --squash --match-head-commit abc123',
      'pr merge 7 --auto --squash --match-head-commit abc123',
    ]);
  });
});
