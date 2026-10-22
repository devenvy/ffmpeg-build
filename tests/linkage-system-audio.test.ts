import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan, linkedRecipe } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';
import { expandPlatforms } from '../src/platforms.ts';

const data = loadEngineData(packageRoot);

describe('ALSA linking and plugin ownership', () => {
  it.each(expandPlatforms(data.recipes.get('alsa-lib')!.platforms))(
    '%s defaults to static with external plugin loading disabled',
    (platform) => {
      expect(linkagePlan(data, ['alsa-lib'], platform)).toEqual({
        modes: { 'alsa-lib': 'static' },
        errors: [],
      });
      const recipe = linkedRecipe(data.recipes.get('alsa-lib')!, 'static');
      expect(recipe.runtime).toEqual([]);
      expect(recipe.build.vars).toMatchObject({
        'shared-arg': '--disable-shared',
        'static-arg': '--enable-static',
        'libdl-arg': '--without-libdl',
      });
      expect(JSON.stringify(recipe.build)).not.toContain('-DPIC');
      expect(recipe.build.args).not.toContain('--with-pic');
    },
  );

  it('offers shared mode for system PulseAudio and PipeWire plugins', () => {
    const recipe = linkedRecipe(data.recipes.get('alsa-lib')!, 'shared');
    expect(recipe.runtime).toEqual([{ value: 'lib/libasound.so*' }]);
    expect(recipe.build.vars).toMatchObject({
      'shared-arg': '--enable-shared',
      'static-arg': '--disable-static',
      'libdl-arg': [],
    });
  });
});
