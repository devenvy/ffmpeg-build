import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('Windows Vulkan shim linking', () => {
  it('keeps the driver-optional static implementation as the default', () => {
    expect(linkagePlan(data, ['vulkan-shim'], 'win-x64').modes['vulkan-shim']).toBe('static');
  });

  it.each(['win-x64', 'win-arm64'])(
    'rejects the unsupported upstream shared mode on %s',
    (platform) => {
      expect(
        linkagePlan(data, ['vulkan-shim'], platform, { 'vulkan-shim': 'shared' }).errors,
      ).toHaveLength(1);
    },
  );
});
