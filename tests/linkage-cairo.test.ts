import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const libraries = ['cairo', 'glib', 'fontconfig', 'freetype'];

describe('Cairo linking ownership', () => {
  it('keeps static default and requires common GObject and font-cache owners for the shared SDK', () => {
    expect(linkagePlan(data, libraries, 'linux-x64').modes['cairo']).toBe('static');
    expect(linkagePlan(data, libraries, 'linux-x64', { cairo: 'shared' }).errors).toHaveLength(2);
    for (const freetype of ['static', 'shared'] as const) {
      const selected = linkagePlan(data, libraries, 'linux-x64', {
        cairo: 'shared',
        glib: 'shared',
        fontconfig: 'shared',
        freetype,
      });
      expect(selected.errors).toEqual([]);
      expect(selected.modes['freetype']).toBe(freetype);
    }
    expect(linkagePlan(data, libraries, 'linux-arm64', { cairo: 'shared' }).errors).toHaveLength(1);
  });
});
