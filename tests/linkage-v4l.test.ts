import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('Native V4L library and decoder process packaging', () => {
  it('retains the static default and limits shared mode to tested Linux x64', () => {
    expect(linkagePlan(data, ['v4l-utils'], 'linux-x64').modes['v4l-utils']).toBe('static');
    expect(linkagePlan(data, ['v4l-utils'], 'linux-x64', { 'v4l-utils': 'shared' }).errors).toEqual(
      [],
    );
    expect(
      linkagePlan(data, ['v4l-utils'], 'linux-arm64', { 'v4l-utils': 'shared' }).errors,
    ).toHaveLength(1);
  });

  it('keeps separately executed decoder program licenses explicit', () => {
    const recipe = data.recipes.get('v4l-utils')!;
    expect(recipe.license).toBe('LGPL-2.1-or-later');
    expect(recipe.notes?.['>=1.32.0']).toContain('GPL-2.0-only');
    expect(recipe.linkage?.modes.shared?.runtime).toEqual([
      { value: 'lib/libv4l1.so*' },
      { value: 'lib/libv4l2.so*' },
      { value: 'lib/libv4lconvert.so*' },
      { value: 'lib/libv4l2rds.so*' },
      { value: 'lib/ov511-decomp' },
      { value: 'lib/ov518-decomp' },
    ]);
  });
});
