import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { platformsOf } from './recipe-harness.ts';
import { configureFlags, makeBuildPlan } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
function temp(): string {
  const directory = mkdtempSync(join(tmpdir(), 'ffb-rust-native-plan-'));
  directories.push(directory);
  return directory;
}

// Planning retains native Cargo packages and licence checks; actual archive compatibility needs native builds.
describe('a target with two Rust libraries', () => {
  const both = platformsOf('librsvg').filter((p) => platformsOf('rav1e').includes(p));
  it('is every platform librsvg builds on: Linux, Windows and Android', () => {
    expect(both).toEqual(platformsOf('librsvg'));
    expect(both.every((p) => /^(linux|win|android)-/.test(p))).toBe(true);
  });

  it.each(both)('%s plans both, and the licence table their crates are checked against', (p) => {
    const r = parseProfileText(
      `name: t\nffmpeg: 9\nplatforms: [${p}]\nlicense: lgplv3\nwith: [rav1e, rsvg]\n`,
      't.yml',
    );
    if (!r.ok) {
      throw new Error(r.errors.join('\n'));
    }
    const planned = planProfile(r.profile, data);
    expect(planned.errors).toEqual([]);
    const cell = planned.cells[0]!;
    const plan = makeBuildPlan({
      profile: r.profile,
      data,
      locked: {
        ffmpeg: { '9': '9.0.2' },
        libraries: Object.fromEntries(cell.recipes.map((n) => [n, '1.0.0'])),
        pinned: [],
      },
      cell,
      variant: 'lgplv3',
      imageId: 'x',
      cacheDir: temp(),
    });
    const rust = plan.libraries.filter((l) => l.build.cargo);
    expect(rust.map((l) => [l.name, l.build.cargo!.package])).toEqual([
      ['librsvg', 'librsvg-c'],
      ['rav1e', 'rav1e'],
    ]);
    expect(plan.cargo?.licenses['MPL-2.0']).toBeDefined();
    expect(configureFlags(data, cell)).toEqual(
      expect.arrayContaining(['--enable-librav1e', '--enable-librsvg']),
    );
  });
});
