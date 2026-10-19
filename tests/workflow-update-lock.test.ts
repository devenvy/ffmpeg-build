// update-lock.yml opens a pull request only when ffmpeg.lock changed, but a new FFmpeg major changes no lock: its note
// would reach no one in a quiet week. The step after `update` raises it from the summary as a warning, every run.
// Runs that step's script as the workflow would, on the summary update writes.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { formatFolderSummary } from '../src/commands/folder-versions.ts';
import { gitBash } from '../src/commands/test.ts';
import { packageRoot } from '../src/paths.ts';
import { parseFolderText } from '../src/targets.ts';

interface Step {
  name?: string;
  run?: string;
}
const steps = (
  parse(readFileSync(join(packageRoot, '.github', 'workflows', 'update-lock.yml'), 'utf8')) as {
    jobs: { update: { steps: Step[] } };
  }
).jobs.update.steps;
const bash = process.platform === 'win32' ? gitBash() : 'bash';

const parsed = parseFolderText(
  'targets:\n  a: { platform: linux-x64, license: gplv3, ffmpeg: 9 }\n',
  '.',
);
if (!parsed.ok) {
  throw new Error(parsed.errors.join('\n'));
}
const nothing = { lock: { ffmpeg: {}, libraries: {} }, rows: [], missing: [], errors: [] };

/** Runs the step on a summary; what it printed and what it added to the run's summary. */
function raise(summary: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-update-lock-'));
  writeFileSync(join(dir, 'pr.md'), summary);
  const step = steps.find((s) => s.name === 'a new FFmpeg major')!;
  const r = spawnSync(bash!, ['-c', step.run!], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      RUNNER_TEMP: dir.replaceAll('\\', '/'),
      GITHUB_STEP_SUMMARY: join(dir, 'step-summary').replaceAll('\\', '/'),
    },
  });
  let added = '';
  try {
    added = readFileSync(join(dir, 'step-summary'), 'utf8');
  } catch {
    // nothing was added
  }
  return { code: r.status, stdout: r.stdout, added };
}

describe.skipIf(!bash)('update-lock.yml and a new FFmpeg major', () => {
  it('runs the step right after update, before the step that ends early on an unchanged lock', () => {
    const names = steps.map((s) => s.name);
    expect(names.indexOf('a new FFmpeg major')).toBe(names.indexOf('update') + 1);
    expect(names.indexOf('result')).toBeGreaterThan(names.indexOf('a new FFmpeg major'));
  });

  it('raises the note update wrote as a warning and in the run summary', () => {
    const note =
      'FFmpeg 10 is out; your targets build 9 (add targets for 10, or use ffmpeg: latest)';
    const r = raise(formatFolderSummary(parsed.folder, nothing, note));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`::warning title=New FFmpeg major::${note}\n`);
    expect(r.added).toBe(`${note}\n`);
  });

  it('says nothing without one', () => {
    const r = raise(formatFolderSummary(parsed.folder, nothing));
    expect(r).toEqual({ code: 0, stdout: '', added: '' });
  });
});
