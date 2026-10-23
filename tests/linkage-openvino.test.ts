import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);

describe('OpenVINO native shared CPU owner', () => {
  it('retains static defaults and allows a bounded Linux x64 shared mode', () => {
    expect(linkagePlan(data, ['openvino'], 'linux-x64').modes['openvino']).toBe('static');
    expect(linkagePlan(data, ['openvino'], 'linux-x64', { openvino: 'shared' }).errors).toEqual([]);
    expect(
      linkagePlan(data, ['openvino'], 'linux-arm64', { openvino: 'shared' }).errors,
    ).toHaveLength(1);
  });

  it('ships the C/C++ runtime, dynamically discovered CPU plugin, IR frontend and plugin metadata', () => {
    expect(
      data.recipes.get('openvino')!.linkage!.modes.shared!.runtime!.map((entry) => entry.value),
    ).toEqual([
      'lib/libopenvino.so*',
      'lib/libopenvino_c.so*',
      'lib/libopenvino_ir_frontend.so*',
      'lib/libopenvino_intel_cpu_plugin.so',
      'lib/plugins.xml',
    ]);
  });
});
