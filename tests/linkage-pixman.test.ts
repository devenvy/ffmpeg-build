import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('pixman runtime linking choices', () => {
  it('keeps static by default and permits a vetted shared implementation under static Cairo', () => {
    expect(linkagePlan(data, ['pixman', 'cairo'], 'linux-x64').modes['pixman']).toBe('static');
    const selected = linkagePlan(data, ['pixman', 'cairo'], 'linux-x64', { pixman: 'shared' });
    expect(selected.errors).toEqual([]);
    expect(selected.modes['pixman']).toBe('shared');
    expect(linkagePlan(data, ['pixman'], 'linux-arm64', { pixman: 'shared' }).errors).toHaveLength(
      1,
    );
  });
});
