import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('Windows Vulkan shim linking', () => {
  it('keeps the driver-optional static implementation as the default', () => {
    expect(linkagePlan(data, ['vulkan-shim'], 'win-x64').modes['vulkan-shim']).toBe('static');
  });

  it('bounds the distinct bundled DLL to verified Windows x64', () => {
    const selected = linkagePlan(data, ['vulkan-shim'], 'win-x64', {
      'vulkan-shim': 'shared',
    });
    expect(selected.errors).toEqual([]);
    expect(data.recipes.get('vulkan-shim')?.linkage?.modes.shared?.runtime).toEqual([
      { value: 'bin/ffb-vulkan-shim.dll' },
    ]);
    expect(
      linkagePlan(data, ['vulkan-shim'], 'win-arm64', { 'vulkan-shim': 'shared' }).errors,
    ).toHaveLength(1);
  });
});
