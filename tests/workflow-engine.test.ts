// The reusable workflows' engine input: "source", an npm version, or a git/npm spec (github:owner/repo#ref), passed
// through env and installed by each workflow's engine step. Runs those steps' scripts with a stand-in npm.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { gitBash } from '../src/commands/test.ts';
import { packageRoot, packageVersion } from '../src/paths.ts';

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
  uses?: string;
  if?: string;
}
interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

const engineSteps = (file: string): Step[] =>
  Object.values(
    (parse(readFileSync(join(packageRoot, '.github', 'workflows', file), 'utf8')) as Workflow).jobs,
  )
    .flatMap((j) => j.steps)
    .filter((s) => s.run?.includes('npm install --global'));

const bash = process.platform === 'win32' ? gitBash() : 'bash';
const major = packageVersion().split('.')[0]!;

/** What npm was asked to do when the step's script runs with `vars` set, beside an ffmpeg.lock of `lock`. */
function npmCalls(step: Step, vars: Record<string, string>, lock = 'engine: 1.2.3\n'): string[] {
  const bin = mkdtempSync(join(tmpdir(), 'ffmpeg-build-npm-'));
  const log = join(bin, 'log');
  // npm pack prints the file it made, last
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env bash\necho "$*" >> "${log.replaceAll('\\', '/')}"\n[ "$1" = pack ] && echo ffmpeg-build-1.2.3.tgz\nexit 0\n`,
    { mode: 0o755 },
  );
  // the engine from source installs with pnpm, through Node's corepack
  writeFileSync(
    join(bin, 'corepack'),
    `#!/usr/bin/env bash\necho "corepack $*" >> "${log.replaceAll('\\', '/')}"\nexit 0\n`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, 'ffmpeg.lock'), lock);
  const fixed = Object.fromEntries(
    Object.entries(step.env ?? {}).filter(([, v]) => !v.includes('${{')),
  ); // the step's own constants
  const r = spawnSync(bash!, ['-c', step.run!], {
    cwd: bin,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...fixed,
      ...vars,
      GITHUB_WORKSPACE: bin,
      RUNNER_TEMP: '/tmp/rt',
      PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
    },
  });
  expect(r.status, r.stderr).toBe(0);
  try {
    return readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

describe.skipIf(!bash)("the workflows' engine input", () => {
  for (const [file, count, variable] of [
    ['build.yml', 5, 'ENGINE'],
    ['update-lock.yml', 1, 'WANTED'],
    ['update-pin.yml', 1, 'ENGINE'],
  ] as const) {
    it(`${file}: a git spec packed then installed, a version from npm, source from this repository; never in the script text`, () => {
      const steps = engineSteps(file);
      expect(steps).toHaveLength(count);
      for (const step of steps) {
        expect(step.run).not.toContain('${{'); // the input reaches the script through env only
        // packed first: npm install --global <git spec> runs its prepare without its devDependencies (no tsc)
        expect(npmCalls(step, { [variable]: 'github:devenvy/ffmpeg-build#main' })).toEqual([
          'pack --silent --pack-destination /tmp/rt github:devenvy/ffmpeg-build#main',
          'install --global /tmp/rt/ffmpeg-build-1.2.3.tgz',
        ]);
        expect(npmCalls(step, { [variable]: '1.3.0' })).toEqual([
          'install --global @devenvy/ffmpeg-build@1.3.0',
        ]);
        expect(npmCalls(step, { [variable]: 'source' })).toEqual([
          'corepack pnpm install --frozen-lockfile',
          'link',
        ]);
      }
    });
  }

  it('every workflow installs an engine the same way (one block, kept identical: a reusable workflow cannot run a script of its own repository)', () => {
    const block = (s: Step) => /case "\$\{ENGINE\}" in[\s\S]*?esac/.exec(s.run!)?.[0];
    const blocks = ['build.yml', 'check.yml', 'update-lock.yml', 'update-pin.yml'].flatMap((f) =>
      engineSteps(f).map(block),
    );
    expect(blocks).toHaveLength(8);
    expect(new Set(blocks).size).toBe(1);
    expect(blocks[0]).toBeDefined();
  });

  it("update-lock.yml installs npm's newest release of the lock's engine major when the input is empty: update moves the engine forward", () => {
    expect(npmCalls(engineSteps('update-lock.yml')[0]!, { WANTED: '' })).toEqual([
      'install --global @devenvy/ffmpeg-build@1',
    ]);
    expect(
      npmCalls(engineSteps('update-lock.yml')[0]!, { WANTED: '' }, 'engine: 1.0.0-rc.1\n'),
    ).toEqual(['install --global @devenvy/ffmpeg-build@1']);
    // a spec the lock names stays as it is
    expect(
      npmCalls(engineSteps('update-lock.yml')[0]!, { WANTED: '' }, 'engine: source\n'),
    ).toEqual(['corepack pnpm install --frozen-lockfile', 'link']);
  });

  it("update-lock.yml takes the workflows' own major when neither the input nor the lock names an engine", () => {
    expect(npmCalls(engineSteps('update-lock.yml')[0]!, { WANTED: '' }, '')).toEqual([
      `install --global @devenvy/ffmpeg-build@${major}`,
    ]);
  });

  it('the defaults are what docs/releases.md says: the lock (build, update-lock), the major (update-pin)', () => {
    const inputs = (file: string) =>
      (
        parse(readFileSync(join(packageRoot, '.github', 'workflows', file), 'utf8')) as {
          on: { workflow_call: { inputs: Record<string, { default?: string }> } };
        }
      ).on.workflow_call.inputs;
    expect(inputs('build.yml')['engine']!.default).toBe('');
    expect(inputs('update-lock.yml')['engine']!.default).toBe('');
    expect(inputs('update-pin.yml')['engine']!.default).toBe(major);
    const docs = readFileSync(join(packageRoot, 'docs', 'releases.md'), 'utf8');
    expect(docs).not.toContain('every workflow defaults');
    expect(docs).toContain(
      `- **\`update-pin.yml\`:** \`${major}\`, npm's newest ${major}.x release`,
    );
  });
});

describe.skipIf(!bash)(
  'the compatibility contract: the @v<major> workflows run engines of that major only',
  () => {
    const contract = (file: string) =>
      Object.values(
        (parse(readFileSync(join(packageRoot, '.github', 'workflows', file), 'utf8')) as Workflow)
          .jobs,
      )
        .flatMap((j) => j.steps)
        .find((s) => s.name === 'the engine suits these workflows');

    for (const file of ['build.yml', 'check.yml', 'update-lock.yml', 'update-pin.yml']) {
      it(`${file}: checks the installed engine's major, which is package.json's`, () => {
        const s = contract(file)!;
        expect(s, file).toBeDefined();
        expect(s.env).toEqual({ WORKFLOWS_MAJOR: major });
        const run = (version: string) => {
          const bin = mkdtempSync(join(tmpdir(), 'ffmpeg-build-contract-'));
          writeFileSync(join(bin, 'ffmpeg-build'), `#!/usr/bin/env bash\necho ${version}\n`, {
            mode: 0o755,
          });
          const r = spawnSync(bash!, ['-e', '-c', s.run!], {
            encoding: 'utf8',
            env: {
              ...process.env,
              ...s.env,
              PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
            },
          });
          return { status: r.status, out: `${r.stdout}${r.stderr}` };
        };
        expect(run(`${major}.0.0`).status).toBe(0);
        expect(run(`${major}.7.3`).status).toBe(0);
        const other = run(`${Number(major) + 1}.0.0`);
        expect(other.status).toBe(1);
        expect(other.out).toContain(
          `::error::ffmpeg-build ${Number(major) + 1}.0.0 is a ${Number(major) + 1}.x engine, but these workflows (@v${major}) run ${major}.x engines only`,
        );
      });
    }

    it('the example workflows call the reusable ones at the same major', () => {
      for (const f of readdirSync(join(packageRoot, 'examples', 'workflows'))) {
        for (const m of readFileSync(
          join(packageRoot, 'examples', 'workflows', f),
          'utf8',
        ).matchAll(/uses: \S+\/\.github\/workflows\/\S+@(\S+)/g)) {
          expect(m[1], f).toBe(`v${major}`);
        }
      }
    });
  },
);

const step = (file: string, name: string): Step =>
  Object.values(
    (parse(readFileSync(join(packageRoot, '.github', 'workflows', file), 'utf8')) as Workflow).jobs,
  )
    .flatMap((j) => j.steps)
    .find((s) => s.name === name)!;

/**
 * The gh (and git) calls a step's script makes, with stand-ins: git succeeds (and `git diff --quiet` says "changed"),
 * gh prints `ghOut` for `gh pr list`. Each call is logged with the GH_TOKEN it ran with.
 */
function calls(s: Step, vars: Record<string, string>, ghOut = ''): string[] {
  const bin = mkdtempSync(join(tmpdir(), 'ffmpeg-build-gh-'));
  const log = join(bin, 'log').replaceAll('\\', '/');
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash\necho "gh[$GH_TOKEN] $*" >> "${log}"\n[ "$1 $2" = "pr list" ] && printf '%s' "${ghOut}"\n[ "$1 $2" = "pr view" ] && printf '%s' "\${GH_VIEW:-}"\nexit 0\n`,
    { mode: 0o755 },
  );
  // what the update jobs hand their publish jobs, in RUNNER_TEMP/update
  mkdirSync(join(bin, 'update'));
  for (const f of ['ffmpeg.lock', 'pr.md', 'ffmpeg.version']) {
    writeFileSync(join(bin, 'update', f), 'x\n');
  }
  // git as a function: it wins over any git on PATH (Git Bash puts its own first)
  const fakeGit = 'git() { if [ "$1" = diff ]; then return 1; fi; return 0; }\n';
  const r = spawnSync(bash!, ['-e', '-c', fakeGit + s.run!], {
    cwd: bin,
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_TOKEN: 'job-token',
      GITHUB_STEP_SUMMARY: join(bin, 'summary'),
      RUNNER_TEMP: bin,
      BRANCH: 'ffmpeg-build/update-lock/root',
      ...vars,
      PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
    },
  });
  expect(r.status, r.stderr).toBe(0);
  try {
    return readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    return [];
  }
}

describe.skipIf(!bash)("the PR's CI and automerge, without a token or repository settings", () => {
  const base = {
    FOLDER: '.',
    PIN: 'ffmpeg.version',
    CHANGE: 'ffmpeg.version: o/r@9.0.2.3',
    CI_WORKFLOW: 'ci.yml',
    DISPATCH_TOKEN: 'github-token',
    LABEL: 'ffmpeg-build:automerge',
  };
  for (const [file, name] of [
    ['update-lock.yml', 'open or refresh the pull request'],
    ['update-pin.yml', 'open or refresh the pull request'],
  ] as const) {
    it(`${file}: dispatches CI with GITHUB_TOKEN when no token was given, and labels instead of gh pr merge --auto`, () => {
      const s = step(file, name);
      expect(s.run).not.toContain('--auto');
      const without = calls(s, { ...base, HAS_TOKEN: 'false', AUTOMERGE: 'true' });
      expect(without).toContain(
        'gh[github-token] workflow run ci.yml --ref ffmpeg-build/update-lock/root',
      );
      expect(without).toContain(
        'gh[job-token] label create ffmpeg-build:automerge --force --color 0e8a16 --description ffmpeg-build merges this PR once its CI passes',
      );
      // a new PR opens with the label, so the CI its opening starts finds it (no label race)
      expect(without.find((c) => c.includes(' pr create '))).toMatch(
        / --label ffmpeg-build:automerge$/,
      );
      expect(without.some((c) => c.includes('--add-label'))).toBe(false);
      // an open PR gets the label before the push that starts its CI
      const open = calls(s, { ...base, HAS_TOKEN: 'false', AUTOMERGE: 'true' }, '12');
      expect(open).toContain(
        'gh[job-token] pr edit ffmpeg-build/update-lock/root --add-label ffmpeg-build:automerge',
      );
      expect(open.some((c) => c.includes(' pr create '))).toBe(false);
      // a token's push starts CI itself; no automerge, no label; an empty ci-workflow dispatches nothing
      const withToken = calls(s, { ...base, HAS_TOKEN: 'true', AUTOMERGE: 'false' });
      expect(withToken.filter((c) => / workflow run | label /.test(c))).toEqual([]);
      expect(
        calls(s, { ...base, HAS_TOKEN: 'false', AUTOMERGE: 'false', CI_WORKFLOW: '' }).filter((c) =>
          c.includes('workflow run'),
        ),
      ).toEqual([]);
    });
  }

  it('ffmpeg-support.yml dispatches the engine ci.yml after a GITHUB_TOKEN push only (an app push starts it)', () => {
    const s = step('ffmpeg-support.yml', 'open or refresh the pull request');
    const temp = mkdtempSync(join(tmpdir(), 'ffmpeg-build-support-'));
    writeFileSync(join(temp, 'support.md'), '**new in 9.1.0**\n');
    const vars = {
      BRANCH: 'ffmpeg-build/ffmpeg-support',
      DISPATCH_TOKEN: 'github-token',
      RUNNER_TEMP: temp,
    };
    expect(calls(s, { ...vars, HAS_APP: 'false' })).toContain(
      'gh[github-token] workflow run ci.yml --ref ffmpeg-build/ffmpeg-support',
    );
    expect(
      calls(s, { ...vars, HAS_APP: 'true' }).filter((c) => c.includes('workflow run')),
    ).toEqual([]);
  });

  it("ffmpeg-support.yml never pushes over a person's commits on its pull request's branch", () => {
    const s = step('ffmpeg-support.yml', 'open or refresh the pull request');
    const temp = mkdtempSync(join(tmpdir(), 'ffmpeg-build-support-'));
    writeFileSync(join(temp, 'support.md'), '**not accounted for**\n');
    const vars = {
      BRANCH: 'ffmpeg-build/ffmpeg-support',
      DISPATCH_TOKEN: 'github-token',
      RUNNER_TEMP: temp,
      HAS_APP: 'false',
    };
    // the open pull request (7) has a commit by someone other than the bot: its text is refreshed, nothing pushed
    const theirs = calls(s, { ...vars, GH_VIEW: '1' }, '7');
    expect(
      theirs.some((c) => c.includes('pr view ffmpeg-build/ffmpeg-support --json commits')),
    ).toBe(true);
    expect(theirs.some((c) => c.includes('pr edit ffmpeg-build/ffmpeg-support'))).toBe(true);
    expect(theirs.filter((c) => c.includes('workflow run'))).toEqual([]);
    // only the bot's: refreshed, and its CI dispatched as before
    expect(calls(s, { ...vars, GH_VIEW: '0' }, '7')).toContain(
      'gh[github-token] workflow run ci.yml --ref ffmpeg-build/ffmpeg-support',
    );
  });

  describe('automerge.yml', () => {
    const s = step('automerge.yml', 'merge the labelled pull request the run tested');
    const vars = {
      BRANCH: 'ffmpeg-build/update-lock/root',
      SHA: 'abc123',
      LABEL: 'ffmpeg-build:automerge',
    };

    it('merges the labelled ffmpeg-build PR whose head is the commit the passing run tested', () => {
      const c = calls(s, vars, '7 abc123');
      expect(c[0]).toBe(
        'gh[job-token] pr list --head ffmpeg-build/update-lock/root --state open --label ffmpeg-build:automerge --json number,headRefOid --jq .[] | "\\(.number) \\(.headRefOid)"',
      );
      expect(c).toContain('gh[job-token] pr merge 7 --squash --match-head-commit abc123');
    });

    it('never merges a newer push, an unlabelled PR, or another branch', () => {
      expect(calls(s, vars, '7 def456').filter((c) => c.includes('pr merge'))).toEqual([]);
      expect(calls(s, vars, '').filter((c) => c.includes('pr merge'))).toEqual([]);
      expect(calls(s, { ...vars, BRANCH: 'feature/x' }, '7 abc123')).toEqual([]);
    });
  });
});

/** Runs a workflow's `branch` step; the branch it outputs, or its exit status and message. */
function branch(
  file: string,
  vars: { WANTED?: string; SOURCE: string },
): { status: number | null; branch?: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-branch-'));
  const env = join(dir, 'env');
  const r = spawnSync(bash!, ['-e', '-c', step(file, 'branch').run!], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, WANTED: '', ...vars, GITHUB_OUTPUT: env },
  });
  let text = '';
  try {
    text = readFileSync(env, 'utf8');
  } catch {
    /* none */
  }
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    branch: /^name=(.*)$/m.exec(text)?.[1],
  };
}

describe.skipIf(!bash)(
  'update-lock.yml and update-pin.yml: one branch per folder or pin file',
  () => {
    interface Called {
      on: { workflow_call: { inputs: Record<string, { default?: string }> } };
      jobs: Record<
        string,
        {
          env?: Record<string, string>;
          concurrency?: { group: string; 'cancel-in-progress': boolean };
          steps: Step[];
        }
      >;
    }
    const read = (file: string) =>
      parse(readFileSync(join(packageRoot, '.github', 'workflows', file), 'utf8')) as Called;

    for (const [file, input, kind] of [
      ['update-lock.yml', 'folder', 'update-lock'],
      ['update-pin.yml', 'pin-file', 'update-pin'],
    ] as const) {
      it(`${file}: a branch input, read through env, set first, never hard-coded`, () => {
        const w = read(file);
        expect(w.on.workflow_call.inputs['branch']!.default).toBe('');
        const job = Object.values(w.jobs)[0]!;
        expect(job.env).not.toHaveProperty('BRANCH');
        expect(job.steps[0]!.name).toBe('branch');
        expect(job.steps[0]!.env).toEqual({
          WANTED: `\${{ inputs.branch }}`,
          SOURCE: `\${{ inputs.${input} }}`,
        });
        // every input reaches every script through env, never its text, in every job
        for (const s of Object.values(w.jobs).flatMap((j) => j.steps)) {
          expect(s.run ?? '').not.toContain('${{');
        }
      });

      it(`${file}: the engine runs with a read-only token, and only the publish job, which runs no engine, writes`, () => {
        const w = read(file) as Called & {
          jobs: Record<string, { permissions?: Record<string, string>; needs?: string }>;
        };
        const [update, publish] = Object.values(w.jobs);
        expect(update!.permissions).toEqual({ contents: 'read' });
        expect(update!.steps.some((s) => s.run?.includes('npm install --global'))).toBe(true);
        expect(publish!.permissions).toEqual({
          actions: 'write',
          contents: 'write',
          'pull-requests': 'write',
        });
        // no engine command, no npm (the label's description names ffmpeg-build, which is fine)
        const runsEngine = /^\s*(ffmpeg-build|npm|npx|corepack)\s/m;
        expect(publish!.steps.some((s) => runsEngine.test(s.run ?? ''))).toBe(false);
        expect(update!.steps.some((s) => runsEngine.test(s.run ?? ''))).toBe(true);
      });

      it(`${file}: one push per repository and resolved branch at a time, never cancelled`, () => {
        const [first, publish] = Object.values(read(file).jobs);
        expect(first!.concurrency).toBeUndefined();
        const c = publish!.concurrency!;
        expect(c.group).toBe(
          `ffmpeg-build-${kind}-\${{ github.repository }}-\${{ needs.${kind === 'update-lock' ? 'update' : 'bump'}.outputs.branch }}`,
        );
        expect(c['cancel-in-progress']).toBe(false);
      });

      it(`${file}: an explicit branch must be a valid ffmpeg-build/ branch (what automerge.yml merges)`, () => {
        expect(branch(file, { WANTED: 'ffmpeg-build/mine', SOURCE: 'x' }).branch).toBe(
          'ffmpeg-build/mine',
        );
        for (const wanted of ['feature/x', 'ffmpeg-build/', 'ffmpeg-buildx/y']) {
          const r = branch(file, { WANTED: wanted, SOURCE: 'x' });
          expect(r.status, wanted).toBe(1);
          expect(r.out).toContain(`::error::branch "${wanted}" must start with ffmpeg-build/`);
        }
        const bad = branch(file, { WANTED: 'ffmpeg-build/a..b', SOURCE: 'x' });
        expect(bad.status).toBe(1);
        expect(bad.out).toContain(`::error::"ffmpeg-build/a..b" isn't a valid branch name`);
      });
    }

    it('update-lock.yml: the default branch is per folder, flat, and keeps the ffmpeg-build/ prefix', () => {
      const of = (folder: string) => branch('update-lock.yml', { SOURCE: folder }).branch;
      expect(of('.')).toBe('ffmpeg-build/update-lock/root');
      expect(of('builds/linux')).toBe('ffmpeg-build/update-lock/builds-linux');
      // another spelling of a folder gets no branch of its own: it is refused (tests/workflow-folder.test.ts)
      expect(of('./')).toBeUndefined();
      expect(of('./builds/linux/')).toBeUndefined();
      expect(of('builds/win x64')).toBe('ffmpeg-build/update-lock/builds-win-x64');
      // two folders in one repository: two pull requests
      expect(of('builds/linux')).not.toBe(of('builds/windows'));
    });

    it('update-pin.yml: the default branch is per pin file', () => {
      const of = (pin: string) => branch('update-pin.yml', { SOURCE: pin }).branch;
      expect(of('ffmpeg.version')).toBe('ffmpeg-build/update-pin/ffmpeg-version');
      expect(of('player/ffmpeg.version')).toBe('ffmpeg-build/update-pin/player-ffmpeg-version');
      expect(of('player/ffmpeg.version')).not.toBe(of('editor/ffmpeg.version'));
    });
  },
);

const jq = spawnSync('jq', ['--version']).status === 0;

/** Runs build.yml's plan step with a stand-in ffmpeg-build whose `releases --json` prints `rows`; its outputs. */
function plan(
  rows: unknown,
  vars: Record<string, string> = {},
): { status: number | null; out: Record<string, string>; stderr: string; calls: string[] } {
  const bin = mkdtempSync(join(tmpdir(), 'ffmpeg-build-plan-'));
  const log = join(bin, 'log').replaceAll('\\', '/');
  writeFileSync(join(bin, 'rows.json'), JSON.stringify(rows));
  writeFileSync(
    join(bin, 'ffmpeg-build'),
    `#!/usr/bin/env bash\necho "$*" >> "${log}"\n[ "$1" = releases ] && cat "${join(bin, 'rows.json').replaceAll('\\', '/')}"\nexit 0\n`,
    { mode: 0o755 },
  );
  const output = join(bin, 'output');
  const r = spawnSync(bash!, ['-e', '-c', step('build.yml', 'releases').run!], {
    cwd: bin,
    encoding: 'utf8',
    env: {
      ...process.env,
      PUBLISH: 'changed-only',
      TESTS: 'all',
      ...vars,
      RUNNER_TEMP: bin,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(bin, 'summary'),
      PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
    },
  });
  let text = '';
  try {
    text = readFileSync(output, 'utf8');
  } catch {
    /* none */
  }
  let logged: string[] = [];
  try {
    logged = readFileSync(log, 'utf8').trim().split('\n');
  } catch {
    /* none */
  }
  return {
    status: r.status,
    stderr: `${r.stdout}${r.stderr}`,
    calls: logged,
    out: Object.fromEntries(
      text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    ),
  };
}

describe.skipIf(!bash || !jq)(
  'build.yml runs every build where it can, and releases only what passed',
  () => {
    const target = (name: string, platform: string, runner: string, testRunner = runner) => ({
      name,
      platform,
      runner,
      testRunner,
      testHere: testRunner === runner,
      in: 'docker',
      cacheKey: `k-${name}`,
    });
    const rows = [
      {
        tag: '9.0.2.0',
        due: true,
        reasons: ['never released'],
        targets: [
          target('lin', 'linux-x64', 'ubuntu-24.04'),
          target('win', 'win-x64', 'ubuntu-24.04', 'windows-2025'),
          target('arm', 'win-arm64', 'ubuntu-24.04', 'windows-11-arm'),
        ],
      },
    ];

    it('builds only the due releases when it publishes changed-only, or with due: true (a pull request check)', () => {
      const releasesCall = (vars: Record<string, string>) =>
        plan(rows, vars).calls.find((c) => c.startsWith('releases'))!;
      expect(releasesCall({ PUBLISH: 'changed-only', DUE: 'false' })).toBe('releases --json --due');
      expect(releasesCall({ PUBLISH: 'never', DUE: 'true' })).toBe('releases --json --due');
      expect(releasesCall({ PUBLISH: 'never', DUE: 'false' })).toBe('releases --json');
      expect(releasesCall({ PUBLISH: 'always', DUE: 'false' })).toBe('releases --json');
    });

    it('gives the test job only the builds their build runner cannot run, on the runner that can', () => {
      const r = plan(rows);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.out['tests']!)).toEqual({
        include: [
          { release: '9.0.2.0', target: 'win', platform: 'win-x64', testRunner: 'windows-2025' },
          {
            release: '9.0.2.0',
            target: 'arm',
            platform: 'win-arm64',
            testRunner: 'windows-11-arm',
          },
        ],
      });
      expect(r.out['any_tests']).toBe('true');
      expect(JSON.parse(r.out['matrix']!).include[1]).toMatchObject({
        target: 'win',
        runner: 'ubuntu-24.04',
        testRunner: 'windows-2025',
      });
      expect(plan([{ ...rows[0], targets: [rows[0]!.targets[0]] }]).out['any_tests']).toBe('false');
    });

    it('gives a full-size release room and time: one runner downloads, bundles and uploads all of it', () => {
      const release = (
        parse(readFileSync(join(packageRoot, '.github', 'workflows', 'build.yml'), 'utf8')) as {
          jobs: Record<string, { 'timeout-minutes'?: number; steps: Step[] }>;
        }
      ).jobs['release']!;
      // ~60 targets: ~100 assets uploaded one by one, after every target's archives and kept sources are downloaded
      expect(release['timeout-minutes']).toBeGreaterThanOrEqual(180);
      const names = release.steps.map((s) => s.name ?? s.uses ?? '');
      const room = names.indexOf('room for a whole release');
      const download = names.findIndex((n) => n.startsWith('actions/download-artifact@'));
      expect(room).toBeGreaterThan(-1);
      expect(room).toBeLessThan(download);
      const run = release.steps[room]!.run!;
      expect(run).toContain('df -h');
      expect(run).not.toMatch(/hostedtoolcache(?!\/CodeQL)/); // setup-node's Node lives there
    });

    it('needs the tests before it releases, and all-builds needs them too', () => {
      const jobs = (
        parse(readFileSync(join(packageRoot, '.github', 'workflows', 'build.yml'), 'utf8')) as {
          jobs: Record<
            string,
            { needs?: string[]; if?: string; 'runs-on'?: string; steps: Step[] }
          >;
        }
      ).jobs;
      expect(jobs['test']!['runs-on']).toBe(`\${{ matrix.testRunner }}`);
      expect(jobs['test']!.if).toContain("inputs.tests == 'all'");
      expect(jobs['test']!.steps.at(-1)!.run).toContain('--must-run');
      expect(jobs['release']!.needs).toContain('test');
      expect(jobs['release']!.if).toContain(
        "(needs.test.result == 'success' || needs.test.result == 'skipped')",
      );
      expect(jobs['all-builds']!.needs).toContain('test');
      // on its build runner a build must run when that is the runner meant to run it
      const t = jobs['build']!.steps.find((s) => s.name === `test \${{ matrix.target }}`)!;
      expect(t.env).toEqual({
        HERE: `\${{ matrix.testHere }}`,
        MATRIX_TARGET: `\${{ matrix.target }}`,
        FFMPEG_BUILD_TEST_ENV: `\${{ secrets.test-env }}`,
      }); // releases says it: expressions can't compare label lists
      expect(t.run).toContain('--must-run');
    });

    it('gives the test-env secret to the two test steps and nothing else, through env (never in a run: line)', () => {
      const text = readFileSync(join(packageRoot, '.github', 'workflows', 'build.yml'), 'utf8');
      const w = parse(text) as {
        on: { workflow_call: { secrets: Record<string, { required: boolean }> } };
        jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>;
      };
      expect(w.on.workflow_call.secrets['test-env']!.required).toBe(false);
      const using = Object.entries(w.jobs).flatMap(([job, j]) => [
        ...(JSON.stringify(j.env ?? {}).includes('secrets.') ? [`${job} env`] : []),
        ...j.steps
          .filter((s) => JSON.stringify(s).includes('secrets.'))
          .map((s) => `${job}: ${String(s.name)}`),
      ]);
      expect(using).toEqual([
        `build: test \${{ matrix.target }}`,
        `test: test \${{ matrix.target }}`,
      ]);
      for (const j of Object.values(w.jobs)) {
        for (const s of j.steps) {
          expect(s.run ?? '').not.toContain('secrets.');
        }
      }
    });
  },
);

describe.skipIf(!bash)("build.yml refuses an input it doesn't know before anything builds", () => {
  const check = (vars: Record<string, string>) => {
    const s = step('build.yml', 'inputs');
    const r = spawnSync(bash!, ['-e', '-c', s.run!], {
      encoding: 'utf8',
      env: { ...process.env, PUBLISH: 'changed-only', TESTS: 'all', FOLDER: '.', ...vars },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };

  it("is the plan job's first step, reading the inputs through env", () => {
    const jobs = (
      parse(
        readFileSync(join(packageRoot, '.github', 'workflows', 'build.yml'), 'utf8'),
      ) as Workflow
    ).jobs;
    const first = jobs['plan']!.steps[0]!;
    expect(first.name).toBe('inputs');
    expect(first.env).toEqual({
      PUBLISH: `\${{ inputs.publish }}`,
      TESTS: `\${{ inputs.tests }}`,
      DUE: `\${{ inputs.due }}`,
      FOLDER: `\${{ inputs.folder }}`,
    });
    expect(first.run).not.toContain('${{');
  });

  it('takes exactly the documented values', () => {
    for (const publish of ['changed-only', 'always', 'never']) {
      for (const tests of ['all', 'build-runner', 'none']) {
        expect(check({ PUBLISH: publish, TESTS: tests }).status).toBe(0);
      }
    }
  });

  it('stops on anything else, naming the input and what it takes', () => {
    // before, "changed_only" built every release and "Never" published
    for (const publish of ['changed_only', 'Never', 'no', '']) {
      const r = check({ PUBLISH: publish });
      expect(r.status, publish).toBe(1);
      expect(r.out).toContain(
        `::error::build.yml input publish is "${publish}"; it takes changed-only, always or never`,
      );
    }
    const r = check({ TESTS: 'windows' });
    expect(r.status).toBe(1);
    expect(r.out).toContain(
      '::error::build.yml input tests is "windows"; it takes all, build-runner or none',
    );
  });
});

describe('the workflows, as written', () => {
  interface AnyStep {
    run?: string;
    with?: Record<string, unknown>;
  }
  interface AnyWorkflow {
    concurrency?: { group: string; 'cancel-in-progress': boolean };
    jobs: Record<string, { 'timeout-minutes'?: number; uses?: string; steps?: AnyStep[] }>;
  }
  const dirs = [
    join(packageRoot, '.github', 'workflows'),
    join(packageRoot, 'examples', 'workflows'),
  ];
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.yml'))
      .map((f) => join(d, f)),
  );
  const read = (path: string) => parse(readFileSync(path, 'utf8')) as AnyWorkflow;

  it('pass expressions to scripts through env, never into the script text', () => {
    const bad: string[] = [];
    for (const path of files) {
      for (const [id, job] of Object.entries(read(path).jobs)) {
        for (const s of job.steps ?? []) {
          const script =
            s.run ?? (typeof s.with?.['script'] === 'string' ? s.with['script'] : undefined);
          if (script?.includes('${{')) {
            bad.push(
              `${path.replace(packageRoot, '')} ${id}: ${script
                .split('\n')
                .find((l) => l.includes('${{'))!
                .trim()}`,
            );
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('give every job that runs steps a timeout', () => {
    const none = files.flatMap((path) =>
      Object.entries(read(path).jobs)
        .filter(([, j]) => !j.uses && j['timeout-minutes'] === undefined)
        .map(([id]) => `${path.replace(packageRoot, '')} ${id}`),
    );
    expect(none).toEqual([]);
  });

  it("run the engine's own CI once per pull request or ref, and the example CI once per ref", () => {
    expect(read(join(packageRoot, '.github', 'workflows', 'ci.yml')).concurrency).toEqual({
      group: `ci-\${{ github.workflow }}-\${{ github.event_name }}-\${{ github.event.pull_request.number || github.ref }}`,
      'cancel-in-progress': true,
    });
    expect(read(join(packageRoot, 'examples', 'workflows', 'ci.yml')).concurrency).toEqual({
      group: `ci-\${{ github.ref }}`,
      'cancel-in-progress': true,
    });
  });

  it('say in each example which repository setting and permissions it needs', () => {
    const examples = readdirSync(join(packageRoot, 'examples', 'workflows'));
    const header = (f: string) =>
      readFileSync(join(packageRoot, 'examples', 'workflows', f), 'utf8').split('\nname:')[0]!;
    for (const f of examples) {
      expect(header(f), f).toMatch(/^# Repository setting: /m);
      expect(header(f), f).toMatch(/^# Permissions: /m);
    }
    for (const f of examples.filter((e) => /update-(lock|pin)/.test(e))) {
      expect(header(f), f).toContain('"Allow GitHub Actions to create and approve pull requests"');
    }
  });
});

describe.skipIf(!bash || spawnSync('jq', ['--version']).status !== 0)(
  "build.yml's publish step",
  () => {
    /**
     * Runs the step; gh's uploads fail `failures` times for b.tar.gz. `existing` is a release already there: a draft a
     * failed run left (from whatever commit it built), or a published one.
     */
    const publish = (failures: number, existing?: 'draft' | 'published') => {
      const temp = mkdtempSync(join(tmpdir(), 'ffmpeg-build-publish-'));
      const dist = join(temp, 'dist');
      mkdirSync(dist);
      writeFileSync(
        join(dist, 'bundle.json'),
        '{"assets": ["a.tar.gz", "b.tar.gz"], "latest": true}',
      );
      writeFileSync(join(dist, 'release-notes.md'), 'notes\n');
      const log = join(temp, 'log').replaceAll('\\', '/');
      const count = join(temp, 'count').replaceAll('\\', '/');
      writeFileSync(
        join(temp, 'gh'),
        [
          '#!/usr/bin/env bash',
          `echo "gh $*" >> "${log}"`,
          `[ "$1 $2" = "release view" ] && { ${existing ? `echo ${existing === 'draft' ? 'true' : 'false'}; exit 0` : 'exit 1'}; }`,
          'if [ "$1 $2 $4" = "release upload b.tar.gz" ]; then',
          `  n=$(($(cat "${count}" 2>/dev/null || echo 0) + 1)); echo "$n" > "${count}"`,
          `  [ "$n" -le ${String(failures)} ] && exit 1`,
          'fi',
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const s = step('build.yml', 'publish');
      const r = spawnSync(bash!, ['-e', '-c', `sleep() { :; }\n${s.run!}`], {
        encoding: 'utf8',
        env: {
          ...process.env,
          RUNNER_TEMP: temp,
          TAG: '9.0.2.4',
          GITHUB_SHA: 'abc123',
          PATH: `${temp}${delimiter}${process.env['PATH'] ?? ''}`,
        },
      });
      return { status: r.status, calls: readFileSync(log, 'utf8').trim().split('\n') };
    };

    it('publishes the draft once every asset is uploaded, trying an upload again', () => {
      const r = publish(2);
      expect(r.status).toBe(0);
      expect(r.calls.at(-1)).toBe('gh release edit 9.0.2.4 --draft=false --latest=true');
    });

    it('leaves the release a draft, and fails, when an asset never uploads', () => {
      const r = publish(3);
      expect(r.status).not.toBe(0);
      expect(r.calls.filter((c) => c.includes('--draft=false'))).toEqual([]);
    });

    it("replaces a draft a failed run left: its assets and tag may be another commit's", () => {
      const r = publish(0, 'draft');
      expect(r.status).toBe(0);
      const at = (prefix: string) => r.calls.findIndex((c) => c.startsWith(prefix));
      expect(r.calls).toContain('gh release delete 9.0.2.4 --yes --cleanup-tag');
      expect(r.calls).toContain(
        'gh release create 9.0.2.4 --draft --title 9.0.2.4 --notes-file release-notes.md --target abc123',
      );
      expect(at('gh release delete')).toBeLessThan(at('gh release create'));
      expect(r.calls.filter((c) => c.startsWith('gh release edit 9.0.2.4 --notes-file'))).toEqual(
        [],
      );
    });

    it('never touches a published release', () => {
      const r = publish(0, 'published');
      expect(r.status).not.toBe(0);
      expect(r.calls.filter((c) => /release (delete|create|upload)/.test(c))).toEqual([]);
    });
  },
);

describe.skipIf(!bash)('the Android emulator test', () => {
  const PREPARE = 'the emulator and its system image, retried (a download can arrive broken)';

  /**
   * Runs the prepare step with a stand-in sdkmanager where the runner keeps it (under ANDROID_HOME, not on PATH) whose
   * first `broken` install calls leave what a broken download does: the files, but no package.xml, so not listed.
   */
  function prepare(broken: number) {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-sdk-'));
    const home = join(dir, 'sdk').replaceAll('\\', '/');
    const bin = join(home, 'cmdline-tools', 'latest', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'sdkmanager'),
      [
        '#!/usr/bin/env bash',
        '[ "$1" = --licenses ] && exit 0',
        `[ "$1" = --list_installed ] && { [ -f "${home}/system-images/android-35/google_apis/x86_64/package.xml" ] && echo "  system-images;android-35;google_apis;x86_64 | 9 | Google APIs"; exit 0; }`,
        `n=$(( $(cat "${home}.calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${home}.calls"`,
        `echo "sdkmanager $*" >> "${home}.log"`,
        `mkdir -p "${home}/emulator" "${home}/system-images/android-35/google_apis/x86_64"`,
        `touch "${home}/emulator/emulator" "${home}/emulator/package.xml" "${home}/system-images/android-35/google_apis/x86_64/system.img"`,
        `[ "$n" -le ${String(broken)} ] && { echo "Warning: An error occurred while preparing SDK package Google APIs Intel x86_64 Atom System Image: Error on ZipFile unknown archive."; exit 0; }`,
        `touch "${home}/system-images/android-35/google_apis/x86_64/package.xml"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const r = spawnSync(bash!, ['-e', '-c', step('build.yml', PREPARE).run!], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ANDROID_HOME: home,
        RETRY_DELAY: '0',
      },
    });
    let tries = 0;
    try {
      tries = Number(readFileSync(`${home}.calls`, 'utf8'));
    } catch {
      /* none */
    }
    return { status: r.status, out: `${r.stdout}${r.stderr}`, tries };
  }

  it('gets the emulator ready before the action that runs it, so a broken download is retried', () => {
    const steps = Object.values(
      (
        parse(
          readFileSync(join(packageRoot, '.github', 'workflows', 'build.yml'), 'utf8'),
        ) as Workflow
      ).jobs,
    ).flatMap((j) => j.steps);
    const ready = steps.findIndex((s) => s.name === PREPARE);
    const emulator = steps.findIndex((s) =>
      s.uses?.startsWith('reactivecircus/android-emulator-runner@'),
    );
    expect(ready).toBeGreaterThan(-1);
    expect(ready).toBeLessThan(emulator);
    expect(steps[ready]!.if).toBe(steps[emulator]!.if);
  });

  it('installs again until sdkmanager lists the image (a broken download leaves files, unlisted), and stops after five tries', () => {
    const once = prepare(1);
    expect(once.status, once.out).toBe(0);
    expect(once.tries).toBe(2);
    const never = prepare(9);
    expect(never.status).not.toBe(0);
    expect(never.tries).toBe(5);
    expect(never.out).toContain('the Android emulator or its system image is still missing');
  });
});

describe.skipIf(!bash)('Rosetta, on a macOS runner building x86_64', () => {
  const ROSETTA = 'Rosetta (x86_64 builds run under it on Apple silicon)';

  /** The step, with Apple's catalog offering no Rosetta for its first `missing` installs; what it ran, and its status. */
  function rosetta(file: string, missing: number, present = false) {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-rosetta-')).replaceAll('\\', '/');
    // arch and sudo as functions: they win over anything on PATH
    const fakes = [
      `arch() { echo "arch $*" >> "${dir}/log"; [ -f "${dir}/installed" ]; }`,
      `sudo() { echo "sudo $*" >> "${dir}/log"; n=$(( $(cat "${dir}/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${dir}/n"; if [ "$n" -le ${String(missing)} ]; then echo 'Rosetta 2 update is not available'; return 1; fi; touch "${dir}/installed"; }`,
      present ? `touch "${dir}/installed"` : '',
      '',
    ].join('\n');
    const r = spawnSync(bash!, ['-e', '-c', fakes + step(file, ROSETTA).run!], {
      encoding: 'utf8',
      env: { ...process.env, RETRY_DELAY: '0' },
    });
    let log: string[] = [];
    try {
      log = readFileSync(`${dir}/log`, 'utf8').trim().split('\n');
    } catch {
      /* none */
    }
    return {
      status: r.status,
      out: `${r.stdout}${r.stderr}`,
      installs: log.filter((l) => l.startsWith('sudo')).length,
    };
  }

  it.each(['build.yml', 'recipes.yml'])(
    '%s: retries an install the catalog refuses, until an x86_64 program runs',
    (file) => {
      expect(rosetta(file, 0, true)).toMatchObject({ status: 0, installs: 0 });
      expect(rosetta(file, 2)).toMatchObject({ status: 0, installs: 3 });
      const never = rosetta(file, 9);
      expect(never.status).not.toBe(0);
      expect(never.installs).toBe(5);
      expect(never.out).toContain('Rosetta is still missing after 5 attempts');
    },
  );
});
