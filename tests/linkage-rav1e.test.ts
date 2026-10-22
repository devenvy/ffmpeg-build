import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('rav1e native shared C SDK', () => {
  it('keeps static default and permits an independent shared mode alongside another Rust consumer', () => {
    expect(linkagePlan(data, ['rav1e'], 'linux-x64').modes['rav1e']).toBe('static');
    const selected = linkagePlan(data, ['rav1e', 'librsvg'], 'linux-x64', { rav1e: 'shared' });
    expect(selected.errors).toEqual([]);
    expect(selected.modes['rav1e']).toBe('shared');
    expect(selected.modes['librsvg']).toBe('static');
    expect(linkagePlan(data, ['rav1e'], 'linux-arm64', { rav1e: 'shared' }).errors).toHaveLength(1);
  });
});
