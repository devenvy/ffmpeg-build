import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const pairs = [
  ['torch', 'tensorflow'],
  ['torch', 'onnxruntime'],
  ['tensorflow', 'onnxruntime'],
];

describe('native ML Protobuf owners', () => {
  it.each(pairs)('rejects incompatible static %s and %s runtimes', (first, second) => {
    const result = linkagePlan(data, [first, second], 'linux-x64');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('incompatible native Protobuf');
  });

  it.each(pairs)('allows native shared isolation for %s and %s', (first, second) => {
    expect(linkagePlan(data, [first, second], 'linux-x64', { [first]: 'shared' }).errors).toEqual(
      [],
    );
    expect(linkagePlan(data, [first, second], 'linux-x64', { [second]: 'shared' }).errors).toEqual(
      [],
    );
  });

  it.each(['torch', 'tensorflow', 'onnxruntime'])(
    '%s keeps its standalone static default',
    (name) => {
      expect(linkagePlan(data, [name], 'linux-x64')).toEqual({
        modes: { [name]: 'static' },
        errors: [],
      });
    },
  );
});
