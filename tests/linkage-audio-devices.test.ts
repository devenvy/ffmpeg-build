import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const libraries = ['openal-soft', 'sndio', 'alsa-lib'];

describe('audio device runtime linking choices', () => {
  it('keeps static adapters and permits independently selected shared backends', () => {
    const defaults = linkagePlan(data, libraries, 'linux-x64');
    expect(defaults.modes['openal-soft']).toBe('static');
    expect(defaults.modes['sndio']).toBe('static');
    for (const library of ['openal-soft', 'sndio']) {
      for (const alsaMode of ['static', 'shared'] as const) {
        const selected = linkagePlan(data, libraries, 'linux-x64', {
          [library]: 'shared',
          'alsa-lib': alsaMode,
        });
        expect(selected.errors).toEqual([]);
        expect(selected.modes[library]).toBe('shared');
        expect(selected.modes['alsa-lib']).toBe(alsaMode);
      }
      expect(
        linkagePlan(data, libraries, 'linux-arm64', { [library]: 'shared' }).errors,
      ).toHaveLength(1);
    }
  });
});
