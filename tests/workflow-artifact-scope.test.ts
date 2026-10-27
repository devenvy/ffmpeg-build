import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { gitBash } from '../src/commands/test.ts';
import { packageRoot } from '../src/paths.ts';

interface Step {
  id?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}
interface Workflow {
  concurrency: { group: string };
  jobs: Record<string, { outputs?: Record<string, string>; steps: Step[] }>;
}

const workflow = parse(
  readFileSync(join(packageRoot, '.github/workflows/build.yml'), 'utf8'),
) as Workflow;
const bash = process.platform === 'win32' ? gitBash() : 'bash';
const directories: string[] = [];
const variable = `\${{ needs.plan.outputs.artifacts }}`;
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scope(folder: string, attempt = '1'): string {
  const step = workflow.jobs['plan']!.steps.find((item) => item.id === 'scope');
  if (!step?.run) {
    throw new Error('The artifact scope step is missing');
  }
  const directory = mkdtempSync(join(tmpdir(), 'ffmpeg-workflow-scope-'));
  directories.push(directory);
  const output = join(directory, 'outputs');
  const result = spawnSync(bash!, ['-e', '-o', 'pipefail', '-c', step.run], {
    encoding: 'utf8',
    env: { ...process.env, FOLDER: folder, GITHUB_RUN_ATTEMPT: attempt, GITHUB_OUTPUT: output },
  });
  expect(result.status, result.stderr).toBe(0);
  const value = /^artifacts=(.+)$/m.exec(readFileSync(output, 'utf8'))?.[1];
  expect(value).toMatch(/^\d+-[a-f0-9]+$/);
  return value!;
}

describe.skipIf(!bash)('reusable build artifact isolation', () => {
  it('lets separate folders build concurrently within the same non-publishing workflow run', () => {
    // Evaluate the fallback format call, with publishing disabled, as GitHub does for these two callers.
    const fallback = workflow.concurrency.group.split('||')[1]!;
    const call = /format\('([^']+)',\s*([^)]+)\)/.exec(fallback)!;
    const group = (folder: string) => {
      const context: Record<string, string> = {
        'github.run_id': 'same-workflow-run',
        'inputs.folder': folder,
      };
      const values = call[2]!.split(',').map((argument) => context[argument.trim()]!);
      return call[1]!.replace(
        /\{(\d+)\}/g,
        (_match: string, index: string) => values[Number(index)]!,
      );
    };
    expect(group('examples/native')).not.toBe(group('examples/test-builds'));
    expect(group('examples/native')).toBe(group('examples/native'));
  });
  it('keeps equal release/target artifacts distinct across folders and complete workflow reruns', () => {
    const upload = workflow.jobs['build']!.steps.find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    )!;
    const name = (prefix: string) =>
      upload
        .with!['name']!.replace(variable, prefix)
        .replace(`\${{ matrix.release }}`, '9.0.2.0')
        .replace(`\${{ matrix.target }}`, 'linux-x64-lgplv3');
    const native = scope('examples/native');
    expect(scope('examples/native')).toBe(native);
    expect(name(native)).not.toBe(name(scope('examples/test-builds')));
    expect(name(native)).not.toBe(name(scope('examples/native', '2')));
  });

  it('carries the same resolved scope through every upload and download, including both release artifact kinds', () => {
    expect(workflow.jobs['plan']!.outputs!['artifacts']).toBe(
      `\${{ steps.scope.outputs.artifacts }}`,
    );
    const transfers = Object.entries(workflow.jobs).flatMap(([job, value]) =>
      value.steps
        .filter((step) => /actions\/(?:upload|download)-artifact@/.test(step.uses ?? ''))
        .map((step) => ({ job, selector: step.with?.['name'] ?? step.with?.['pattern'] })),
    );
    expect(transfers.map((item) => item.job)).toEqual(['build', 'test', 'ios', 'ios', 'release']);
    for (const transfer of transfers) {
      expect(transfer.selector, transfer.job).toContain(variable);
    }
    expect(transfers.find((item) => item.job === 'release')!.selector).toContain('{dist,ios}');
  });
});
