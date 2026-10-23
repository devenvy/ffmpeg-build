import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('MPEG-H linking choices', () => {
  it('keeps static defaults and allows the full shared decoder/UI SDK on Linux x64', () => {
    expect(linkagePlan(data, ['mpeghdec'], 'linux-x64').modes['mpeghdec']).toBe('static');
    const selected = linkagePlan(data, ['mpeghdec'], 'linux-x64', { mpeghdec: 'shared' });
    expect(selected.errors).toEqual([]);
    expect(selected.modes['mpeghdec']).toBe('shared');
    expect(
      linkagePlan(data, ['mpeghdec'], 'linux-arm64', { mpeghdec: 'shared' }).errors,
    ).toHaveLength(1);
  });
});
