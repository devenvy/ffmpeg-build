import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('Whisper and GGML shared runtime', () => {
  it('keeps static default and permits either Vulkan loader mode without imposing a handle owner', () => {
    expect(linkagePlan(data, ['whisper.cpp'], 'linux-x64').modes['whisper.cpp']).toBe('static');
    for (const loader of ['static', 'shared'] as const) {
      const selected = linkagePlan(data, ['whisper.cpp', 'vulkan-loader'], 'linux-x64', {
        'whisper.cpp': 'shared',
        'vulkan-loader': loader,
      });
      expect(selected.errors).toEqual([]);
      expect(selected.modes['whisper.cpp']).toBe('shared');
    }
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
