import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const libraries = ['aribb24', 'libaribcaption', 'zvbi', 'libklvanc'];

describe('Caption library linking choices', () => {
  it('keeps static defaults and permits independent Linux x64 shared selections', () => {
    for (const library of libraries) {
      expect(linkagePlan(data, libraries, 'linux-x64').modes[library]).toBe('static');
      const plan = linkagePlan(data, [...libraries, 'freetype', 'fontconfig'], 'linux-x64', {
        [library]: 'shared',
        ...(library === 'libaribcaption' ? { freetype: 'shared', fontconfig: 'shared' } : {}),
      });
      expect(plan.errors).toEqual([]);
      expect(plan.modes[library]).toBe('shared');
      expect(
        linkagePlan(data, [library], 'linux-arm64', { [library]: 'shared' }).errors,
      ).toHaveLength(1);
    }
  });

  it('rejects a shared ARIB renderer with the unsupported static font closure', () => {
    expect(
      linkagePlan(data, ['libaribcaption', 'freetype', 'fontconfig'], 'linux-x64', {
        libaribcaption: 'shared',
      }).errors,
    ).toHaveLength(2);
  });
});
