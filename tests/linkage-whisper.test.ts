import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('Whisper and GGML shared runtime', () => {
  it('keeps the static processing default and permits a shared runtime with the native shared loader', () => {
    expect(linkagePlan(data, ['whisper.cpp'], 'linux-x64').modes['whisper.cpp']).toBe('static');
    const selected = linkagePlan(data, ['whisper.cpp', 'vulkan-loader'], 'linux-x64', {
      'whisper.cpp': 'shared',
    });
    expect(selected.errors).toEqual([]);
    expect(selected.modes['whisper.cpp']).toBe('shared');
    expect(selected.modes['vulkan-loader']).toBe('shared');
    expect(
      linkagePlan(data, ['whisper.cpp'], 'linux-arm64', { 'whisper.cpp': 'shared' }).errors,
    ).toHaveLength(1);
  });

  it('includes Parakeet and the complete CPU/GGML/backend native library family', () => {
    expect(
      data.recipes.get('whisper.cpp')!.linkage!.modes.shared!.runtime!.map((entry) => entry.value),
    ).toEqual(['lib/libwhisper.so*', 'lib/libparakeet.so*', 'lib/libggml*.so*']);
  });
});
