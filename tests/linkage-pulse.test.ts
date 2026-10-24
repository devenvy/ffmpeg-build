import { expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan, linkedRecipe } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';
import { expandPlatforms } from '../src/platforms.ts';

const data = loadEngineData(packageRoot);
const RUNTIMES = {
  pulseaudio: ['lib/libpulse.so*', 'lib/pulseaudio/libpulsecommon-*.so'],
  jack2: ['lib/libjack.so*'],
};
for (const name of ['pulseaudio'] as const) {
  const recipe = data.recipes.get(name)!;
  it.each(expandPlatforms(recipe.platforms))(
    `${name} on %s defaults to static with shared opt-in`,
    (platform) => {
      expect(linkagePlan(data, [name], platform)).toEqual({
        modes: { [name]: 'static' },
        errors: [],
      });
      expect(linkedRecipe(recipe, 'static').runtime).toEqual([]);
      expect(linkedRecipe(recipe, 'shared').runtime).toEqual(
        RUNTIMES[name].map((value) => ({ value })),
      );
    },
  );
}

it.each(expandPlatforms(data.recipes.get('jack2')!.platforms))(
  'JACK2 on %s uses its native shared client and rejects a patched static build',
  (platform) => {
    expect(linkagePlan(data, ['jack2'], platform)).toEqual({
      modes: { jack2: 'shared' },
      errors: [],
    });
    expect(linkagePlan(data, ['jack2'], platform, { jack2: 'static' }).errors).toHaveLength(1);
    expect(linkedRecipe(data.recipes.get('jack2')!, 'shared').runtime).toEqual(
      RUNTIMES.jack2.map((value) => ({ value })),
    );
  },
);
