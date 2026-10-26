import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('TensorFlow native C and eager runtime linking', () => {
  it('uses the native shared owner and rejects unsupported static FFmpeg integration', () => {
    expect(linkagePlan(data, ['tensorflow'], 'linux-x64').modes['tensorflow']).toBe('shared');
    expect(
      linkagePlan(data, ['tensorflow'], 'linux-x64', { tensorflow: 'static' }).errors,
    ).toHaveLength(1);
    expect(linkagePlan(data, ['tensorflow'], 'linux-x64', { tensorflow: 'shared' }).errors).toEqual(
      [],
    );
    expect(
      linkagePlan(data, ['tensorflow'], 'linux-arm64', { tensorflow: 'shared' }).errors,
    ).toHaveLength(1);
  });

  it('ships the complete native monolithic C owner without an unused framework library', () => {
    expect(
      data.recipes.get('tensorflow')!.linkage!.modes.shared!.runtime!.map((entry) => entry.value),
    ).toEqual(['lib/libtensorflow.so*']);
  });
});
