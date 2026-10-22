import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const libraries = ['librsvg', 'pango', 'cairo', 'glib', 'fontconfig', 'freetype', 'harfbuzz'];

describe('Pango and librsvg shared ownership', () => {
  it('keeps static defaults and requires common GObject, Cairo and font-cache owners', () => {
    const defaults = linkagePlan(data, libraries, 'linux-x64');
    expect(defaults.modes['pango']).toBe('static');
    expect(defaults.modes['librsvg']).toBe('static');
    expect(
      linkagePlan(data, libraries, 'linux-x64', { pango: 'shared' }).errors.length,
    ).toBeGreaterThan(0);
    expect(
      linkagePlan(data, libraries, 'linux-x64', { librsvg: 'shared' }).errors.length,
    ).toBeGreaterThan(0);
    for (const harfbuzz of ['shared'] as const) {
      for (const freetype of ['static', 'shared'] as const) {
        const selected = linkagePlan(data, libraries, 'linux-x64', {
          librsvg: 'shared',
          pango: 'shared',
          cairo: 'shared',
          glib: 'shared',
          fontconfig: 'shared',
          harfbuzz,
          freetype,
        });
        expect(selected.errors).toEqual([]);
        expect(selected.modes['harfbuzz']).toBe(harfbuzz);
        expect(selected.modes['freetype']).toBe(freetype);
      }
    }
    expect(
      linkagePlan(data, libraries, 'linux-x64', {
        pango: 'shared',
        cairo: 'shared',
        glib: 'shared',
        fontconfig: 'shared',
        harfbuzz: 'static',
      }).errors,
    ).toHaveLength(1);
  });

  it('limits the new modes to the verified platform and inventories every native library', () => {
    for (const name of ['pango', 'librsvg']) {
      expect(
        linkagePlan(data, libraries, 'linux-arm64', { [name]: 'shared' }).errors.length,
      ).toBeGreaterThan(0);
    }
    expect(
      data.recipes.get('pango')!.linkage!.modes.shared!.runtime!.map((entry) => entry.value),
    ).toEqual(['lib/libpango-1.0.so*', 'lib/libpangoft2-1.0.so*', 'lib/libpangocairo-1.0.so*']);
    expect(
      data.recipes.get('librsvg')!.linkage!.modes.shared!.runtime!.map((entry) => entry.value),
    ).toEqual(['lib/librsvg-2.so*']);
  });
});
