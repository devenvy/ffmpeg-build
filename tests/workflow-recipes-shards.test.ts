import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { gitBash } from '../src/commands/test.ts';
import { packageRoot } from '../src/paths.ts';

const workflow = parse(
  readFileSync(join(packageRoot, '.github/workflows/recipes.yml'), 'utf8'),
) as {
  jobs: {
    changed: { steps: { id?: string; run?: string }[] };
    recipe: { steps: { name?: string; run?: string }[] };
  };
};
const planning = workflow.jobs.changed.steps.find((step) => step.id === 'plan')!.run!;
const expression = /matrix=\$\(jq -c '([^']+)'/s.exec(planning)![1]!;
const jq = spawnSync('jq', ['--version']).status === 0;
const bash = process.platform === 'win32' ? gitBash() : 'bash';

interface Target {
  name: string;
  only: string[];
}
interface Platform {
  platform: string;
  runner: string;
  targets: Target[];
}
interface Shard {
  platform: string;
  runner: string;
  shard: string;
  targets: string;
}

function matrix(platforms: Platform[]): Shard[] {
  const result = spawnSync('jq', ['-c', expression], {
    input: JSON.stringify({ platforms }),
    encoding: 'utf8',
  });
  expect(result.status, result.stderr).toBe(0);
  return (JSON.parse(result.stdout) as { include: Shard[] }).include;
}

describe.skipIf(!jq)('recipe CI avoids cold native ML build timeouts', () => {
  it('keeps every target exactly once while giving each expensive native owner its own job', () => {
    const targets = [
      { name: 'linux-x64-ass', only: ['freetype', 'libass'] },
      { name: 'linux-x64-tensorflow', only: ['tensorflow'] },
      { name: 'linux-x64-torch', only: ['torch'] },
      { name: 'linux-x64-vpx', only: ['libvpx'] },
    ];
    const shards = matrix([{ platform: 'linux-x64', runner: 'ubuntu-24.04', targets }]);
    expect(shards).toHaveLength(3);
    expect(shards.flatMap((shard) => shard.targets.split(' ')).sort()).toEqual(
      targets.map((target) => target.name).sort(),
    );
    expect(new Set(shards.map((shard) => shard.shard)).size).toBe(3);
    for (const owner of ['tensorflow', 'torch']) {
      expect(shards.find((shard) => shard.targets.includes(owner))!.targets).toBe(
        `linux-x64-${owner}`,
      );
    }
  });

  it('keeps ordinary platforms together and preserves their selected runner', () => {
    const shards = matrix([
      {
        platform: 'osx-arm64',
        runner: 'macos-15',
        targets: [
          { name: 'osx-arm64-ass', only: ['libass'] },
          { name: 'osx-arm64-vpx', only: ['libvpx'] },
        ],
      },
    ]);
    expect(shards).toEqual([
      {
        platform: 'osx-arm64',
        runner: 'macos-15',
        shard: 'ordinary',
        targets: 'osx-arm64-ass osx-arm64-vpx',
      },
    ]);
  });

  it('does not create empty ordinary jobs when only an expensive target changed', () => {
    const shards = matrix([
      {
        platform: 'linux-x64',
        runner: 'ubuntu-24.04',
        targets: [{ name: 'linux-x64-torch', only: ['torch'] }],
      },
    ]);
    expect(shards).toHaveLength(1);
    expect(shards[0]!.targets).toBe('linux-x64-torch');
    expect(matrix([])).toEqual([]);
  });
});

it.skipIf(!jq || !bash)(
  'builds only assigned locked targets and continues after an individual failure',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffb-recipe-shard-'));
    try {
      const bin = join(dir, 'bin');
      const folder = join(dir, 'recipe-check');
      const calls = join(dir, 'calls');
      mkdirSync(bin);
      mkdirSync(folder);
      writeFileSync(
        join(folder, 'recipe-check.json'),
        JSON.stringify({
          plan: {
            targets: [
              { name: 'linux-x64-first', only: ['one', 'two'] },
              { name: 'linux-x64-second', only: ['three'] },
              { name: 'linux-x64-tensorflow', only: ['tensorflow'] },
            ],
          },
        }),
      );
      writeFileSync(
        join(bin, 'ffmpeg-build'),
        '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$CALL_LOG"\ncase "$*" in *linux-x64-first*) exit 1;; esac\n',
        { mode: 0o755 },
      );
      const step = workflow.jobs.recipe.steps.find((item) =>
        item.run?.includes('ffmpeg-build build --target'),
      )!;
      const result = spawnSync(bash!, ['-e', '-o', 'pipefail', '-c', step.run!], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}`,
          RUNNER_TEMP: dir.replaceAll('\\', '/'),
          CALL_LOG: calls.replaceAll('\\', '/'),
          TARGETS: 'linux-x64-first linux-x64-second',
        },
      });
      expect(result.status, result.stderr).toBe(1);
      const lines = readFileSync(calls, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('build --target linux-x64-first --only one,two --out ');
      expect(lines[1]).toContain('build --target linux-x64-second --only three --out ');
      expect(lines.join('\n')).not.toContain('tensorflow');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
