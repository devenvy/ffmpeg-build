// The folder input of build.yml and update-lock.yml names a concurrency group (and update-lock's branch), so one folder
// must have one spelling: `.` and `./` would otherwise queue apart and race. The first step refuses any other
// spelling. Runs that step's script as the workflow would.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { gitBash } from '../src/commands/test.ts';
import { packageRoot } from '../src/paths.ts';

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Workflow {
  on: { workflow_call: { inputs: Record<string, { description?: string }> } };
  jobs: Record<string, { steps: Step[] }>;
}
const workflow = (file: string) =>
  parse(readFileSync(join(packageRoot, '.github', 'workflows', file), 'utf8')) as Workflow;
const bash = process.platform === 'win32' ? gitBash() : 'bash';

// each workflow's first step, the variable it reads the folder from, and what else it needs to pass with a good folder
// (update-lock.yml's branch step names it SOURCE, as update-pin.yml's does its pin file)
const checks: { file: string; step: Step; variable: string; env: Record<string, string> }[] = [
  {
    file: 'build.yml',
    step: workflow('build.yml').jobs['plan']!.steps[0]!,
    variable: 'FOLDER',
    env: { PUBLISH: 'never', TESTS: 'all', DUE: 'false' },
  },
  {
    file: 'update-lock.yml',
    step: workflow('update-lock.yml').jobs['update']!.steps[0]!,
    variable: 'SOURCE',
    env: { WANTED: '' },
  },
];

const run = (step: Step, vars: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-folder-'));
  const r = spawnSync(bash!, ['-c', step.run!], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: join(dir, 'out').replaceAll('\\', '/'), ...vars },
  });
  return { code: r.status ?? -1, stdout: r.stdout };
};

describe.skipIf(!bash)('the folder input has one spelling per folder', () => {
  for (const { file, step, variable, env } of checks) {
    it(`${file}: its first step reads the folder through env`, () => {
      expect(step.env?.[variable]).toBe(`\${{ inputs.folder }}`);
      expect(step.run).not.toContain('${{');
    });

    it(`${file}: takes . and a plain relative path`, () => {
      for (const folder of ['.', 'builds/linux', 'linux', 'my.builds/x-1']) {
        expect(run(step, { ...env, [variable]: folder }).code, folder).toBe(0);
      }
    });

    it(`${file}: refuses ./, a trailing /, .., backslashes and the like, saying how to write it`, () => {
      for (const folder of [
        './',
        './builds/linux',
        'builds/linux/',
        '..',
        '../x',
        'builds/../linux',
        'builds/..',
        'builds\\linux',
        '/builds',
        'builds//linux',
        'builds/./linux',
        '',
      ]) {
        const r = run(step, { ...env, [variable]: folder });
        expect(r.code, JSON.stringify(folder)).toBe(1);
        expect(r.stdout, JSON.stringify(folder)).toContain(
          `::error::${file} input folder is "${folder}"`,
        );
        expect(r.stdout).toContain(
          'write it as . (the repository root) or a relative path like builds/linux',
        );
      }
    });

    it(`${file}: the input's description says how to write it`, () => {
      expect(workflow(file).on.workflow_call.inputs['folder']!.description).toMatch(
        /\. or .*builds\/linux/,
      );
    });
  }
});
