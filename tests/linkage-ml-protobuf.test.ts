import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
describe('native ML runtime owners', () => {
  it('combines private shared owners with the supported native static defaults', () => {
    expect(
      linkagePlan(data, ['torch', 'tensorflow', 'onnxruntime', 'openvino'], 'linux-x64'),
    ).toEqual({
      modes: {
        torch: 'shared',
        tensorflow: 'shared',
        onnxruntime: 'static',
        openvino: 'static',
      },
      errors: [],
    });
  });
});
