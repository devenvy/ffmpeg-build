import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const libraries = ['shaderc', 'libplacebo', 'vulkan-loader'];

describe('Vulkan graphics library linking choices', () => {
  it('keeps static defaults and permits shared processing with either caller-owned loader', () => {
    for (const library of ['shaderc', 'libplacebo']) {
      expect(linkagePlan(data, libraries, 'linux-x64').modes[library]).toBe('static');
      for (const loaderMode of ['static', 'shared'] as const) {
        const selected = linkagePlan(data, libraries, 'linux-x64', {
          [library]: 'shared',
          'vulkan-loader': loaderMode,
        });
        expect(selected.errors).toEqual([]);
        expect(selected.modes[library]).toBe('shared');
        expect(selected.modes['vulkan-loader']).toBe(loaderMode);
      }
      expect(
        linkagePlan(data, libraries, 'linux-arm64', { [library]: 'shared' }).errors,
      ).toHaveLength(1);
    }
  });
});
