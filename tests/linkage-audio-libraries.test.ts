import { describe, expect, it } from 'vitest';

import { broughtComponents } from '../src/component-lists.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const LIBRARIES = ['libogg', 'libvorbis', 'opus', 'speex', 'libmp3lame', 'shine'];

describe('audio library linking choices', () => {
  it.each(['8', '9'])(
    '%s retains the external audio encoders and decoders in restricted targets',
    (major) => {
      const components = broughtComponents(data, {
        major,
        platform: 'linux-x64',
        options: ['opus', 'vorbis', 'speex'],
      });
      expect(components.encoders).toEqual(
        expect.arrayContaining(['libopus', 'libvorbis', 'libspeex']),
      );
      expect(components.decoders).toEqual(
        expect.arrayContaining(['libopus', 'libvorbis', 'libspeex']),
      );
    },
  );
  it.each(LIBRARIES)('%s keeps static by default and offers Linux x64 shared builds', (name) => {
    expect(linkagePlan(data, [name], 'linux-x64')).toEqual({
      modes: { [name]: 'static' },
      errors: [],
    });
    expect(linkagePlan(data, [name], 'linux-x64', { [name]: 'shared' })).toEqual({
      modes: { [name]: 'shared' },
      errors: [],
    });
    expect(data.recipes.get(name)!.linkage!.modes.shared!.runtime!.length).toBeGreaterThan(0);
  });

  it.each(LIBRARIES)(
    '%s preserves static elsewhere and rejects unverified shared platforms',
    (name) => {
      expect(linkagePlan(data, [name], 'win-x64').modes[name]).toBe('static');
      expect(linkagePlan(data, [name], 'win-x64', { [name]: 'shared' }).errors).toEqual([
        `link: ${name} does not support shared linking on win-x64`,
      ]);
    },
  );
});
