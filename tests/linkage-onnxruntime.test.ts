import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('ONNX Runtime native shared CPU SDK', () => {
  it('retains static defaults and bounds shared mode to the verified platform', () => {
    expect(linkagePlan(data, ['onnxruntime'], 'linux-x64').modes['onnxruntime']).toBe('static');
    expect(
      linkagePlan(data, ['onnxruntime'], 'linux-x64', { onnxruntime: 'shared' }).errors,
    ).toEqual([]);
    expect(
      linkagePlan(data, ['onnxruntime'], 'linux-arm64', { onnxruntime: 'shared' }).errors,
    ).toHaveLength(1);
  });

  it('ships the native runtime and provider bridge as one owner', () => {
    expect(
      data.recipes.get('onnxruntime')!.linkage!.modes.shared!.runtime!.map((entry) => entry.value),
    ).toEqual(['lib/libonnxruntime.so*', 'lib/libonnxruntime_providers_shared.so']);
  });
});
