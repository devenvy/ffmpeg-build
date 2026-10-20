// The example folders CI builds: canary.yml builds the canary's targets every week against the newest upstream
// versions, so a recipe no canary target builds would never meet a new upstream release there.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { planProfile } from '../src/resolve.ts';
import { parseFolderText, targetProfile } from '../src/targets.ts';

const data = loadEngineData(packageRoot);

function recipesOf(dir: string): Map<string, string[]> {
  const r = parseFolderText(readFileSync(join(dir, 'ffmpeg-build.yml'), 'utf8'), dir);
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  const folder = r.folder;
  return new Map(
    folder.targets.map((t) => {
      const plan = planProfile(targetProfile(folder, t), data, { '8': '8.1.3', '9': '9.0.2' });
      if (plan.errors.length) {
        throw new Error(`${t.name}: ${plan.errors.join('\n')}`);
      }
      return [t.name, plan.cells.flatMap((c) => c.recipes)];
    }),
  );
}

describe('examples/canary', () => {
  const canary = recipesOf(join(packageRoot, 'examples', 'canary'));

  it('builds every recipe on some target', () => {
    const built = new Set([...canary.values()].flat());
    expect([...data.recipes.keys()].filter((r) => !built.has(r)).sort()).toEqual([]);
  });

  it('builds MoltenVK as macOS ships it: the dylib and ICD manifest beside the Khronos loader', () => {
    const using = [...canary].filter(([, recipes]) => recipes.includes('moltenvk'));
    expect(using.map(([name]) => name)).toEqual(['osx-arm64-lgplv3']);
    expect(canary.get('osx-arm64-lgplv3')).toContain('vulkan-loader');
  });
});

// The canary can't hold iOS or Mac Catalyst targets without all four xcframework slices; the test builds have them,
// so the static MoltenVK that iOS and Mac Catalyst link is built there (toolchains.yml).
describe('examples/test-builds', () => {
  const builds = recipesOf(join(packageRoot, 'examples', 'test-builds'));

  it('builds MoltenVK statically for iOS and Mac Catalyst', () => {
    const using = [...builds].filter(([, recipes]) => recipes.includes('moltenvk'));
    expect(using.map(([name]) => name).sort()).toEqual([
      'ios-arm64-lgplv3',
      'maccatalyst-arm64-lgplv3',
    ]);
  });
});
