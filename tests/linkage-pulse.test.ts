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
for (const name of ['pulseaudio', 'jack2'] as const) {
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
