// build.yml's platforms input: the plan step passes it to `releases --platform` (through env), and asks for whole
// releases (--whole) whenever the run publishes. Runs that step's script with a stand-in ffmpeg-build.
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
  run?: string;
}
const plan = (
  parse(readFileSync(join(packageRoot, '.github', 'workflows', 'build.yml'), 'utf8')) as {
    jobs: { plan: { steps: Step[] } };
  }
).jobs.plan.steps.find((s) => s.id === 'plan')!;
const bash = process.platform === 'win32' ? gitBash() : 'bash';

/** The `releases` arguments the step passes, and its exit code, with the stand-in answering `answer` and `status`. */
function releasesCall(
  vars: Record<string, string>,
  answer = '[]',
  status = 0,
): { args: string; code: number; stdout: string } {
  const bin = mkdtempSync(join(tmpdir(), 'ffmpeg-build-plan-'));
  const log = join(bin, 'log').replaceAll('\\', '/');
  writeFileSync(
    join(bin, 'ffmpeg-build'),
    `#!/usr/bin/env bash\nif [ "$1" = releases ]; then echo "$*" > "${log}"; echo '${answer}'; exit ${status}; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  const out = join(bin, 'out').replaceAll('\\', '/');
  const r = spawnSync(bash!, ['-c', plan.run!], {
    cwd: bin,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...vars,
      RUNNER_TEMP: bin.replaceAll('\\', '/'),
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: out,
      PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
    },
  });
  let args = '';
  try {
    args = readFileSync(log, 'utf8').trim();
  } catch {
    /* releases never ran */
  }
  return { args, code: r.status ?? -1, stdout: r.stdout };
}

describe.skipIf(!bash)("build.yml's platforms input", () => {
  it('reaches the script through env only', () => {
    expect(plan.run).not.toContain('${{');
  });

  it('passes the choice to releases, asking for whole releases when publishing', () => {
    expect(releasesCall({ PUBLISH: 'changed-only', PLATFORMS: '' }).args).toBe(
      'releases --json --due',
    );
    expect(releasesCall({ PUBLISH: 'never', PLATFORMS: 'linux-*,win-*' }).args).toBe(
      'releases --json --platform linux-*,win-*',
    );
    expect(releasesCall({ PUBLISH: 'always', PLATFORMS: 'osx-*' }).args).toBe(
      'releases --json --platform osx-* --whole',
    );
  });

  it("stops with releases' error when a release would be published part-built", () => {
    const r = releasesCall(
      { PUBLISH: 'always', PLATFORMS: 'linux-*' },
      '{"error": "9.1.0.0 would be published without mac"}',
      1,
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('::error::9.1.0.0 would be published without mac');
  });
});

describe.skipIf(!bash)("build.yml's due input", () => {
  const inputs = (
    parse(readFileSync(join(packageRoot, '.github', 'workflows', 'build.yml'), 'utf8')) as {
      jobs: { plan: { steps: (Step & { name?: string })[] } };
    }
  ).jobs.plan.steps.find((s) => s.name === 'inputs')!;
  const checkInputs = (vars: Record<string, string>) => {
    const r = spawnSync(bash!, ['-c', inputs.run!], {
      encoding: 'utf8',
      env: { ...process.env, TESTS: 'all', FOLDER: '.', ...vars },
    });
    return { code: r.status ?? -1, stdout: r.stdout };
  };

  it('narrows only publish: never; publish: always still builds every release', () => {
    expect(releasesCall({ PUBLISH: 'never', DUE: 'true', PLATFORMS: '' }).args).toBe(
      'releases --json --due',
    );
    expect(releasesCall({ PUBLISH: 'never', DUE: 'false', PLATFORMS: '' }).args).toBe(
      'releases --json',
    );
    expect(releasesCall({ PUBLISH: 'always', DUE: 'true', PLATFORMS: '' }).args).toBe(
      'releases --json',
    );
  });

  it('is refused with publish other than never, with a clear error', () => {
    expect(checkInputs({ PUBLISH: 'never', DUE: 'true' }).code).toBe(0);
    expect(checkInputs({ PUBLISH: 'always', DUE: 'false' }).code).toBe(0);
    for (const publish of ['always', 'changed-only']) {
      const r = checkInputs({ PUBLISH: publish, DUE: 'true' });
      expect(r.code, publish).toBe(1);
      expect(r.stdout, publish).toContain(
        `::error::build.yml input due is true with publish ${publish}`,
      );
    }
  });
});

describe("build.yml's jobs on a runner the matrix picks", () => {
  it('run their steps with bash, so a Windows runner (PowerShell by default) runs them too', () => {
    const jobs = (
      parse(readFileSync(join(packageRoot, '.github', 'workflows', 'build.yml'), 'utf8')) as {
        jobs: Record<string, { 'runs-on': string; defaults?: { run?: { shell?: string } } }>;
      }
    ).jobs;
    const picked = Object.entries(jobs).filter(([, j]) => j['runs-on'].includes('matrix.'));
    expect(picked.map(([n]) => n).sort()).toEqual(['build', 'test']);
    for (const [name, j] of picked) {
      expect(j.defaults?.run?.shell, name).toBe('bash');
    }
  });
});

describe('build.yml runs that publish', () => {
  it("queue behind each other per repository and folder, so a later run plans after an earlier one published (PR builds don't wait)", () => {
    const wf = parse(
      readFileSync(join(packageRoot, '.github', 'workflows', 'build.yml'), 'utf8'),
    ) as { concurrency?: { group?: string; 'cancel-in-progress'?: boolean } };
    expect(wf.concurrency?.['cancel-in-progress']).toBe(false);
    expect(wf.concurrency?.group).toContain("inputs.publish != 'never'");
    expect(wf.concurrency?.group).toContain('github.repository');
    expect(wf.concurrency?.group).toContain('inputs.folder');
    expect(wf.concurrency?.group).toContain('github.run_id');
  });
});
