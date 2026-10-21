import { describe, expect, it } from 'vitest';

import { configureFlags } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);

describe('ONNX Runtime CPU backend', () => {
  it.each(['lgplv3', 'gplv3', 'nonfree'])('is opt-in under %s', (license) => {
    const parsed = parseProfileText(
      `name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: ${license}\nwith: [onnxruntime]\n`,
      't.yml',
    );
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('\n'));
    }
    const plan = planProfile(parsed.profile, data, { '9': '9.0.2' });
    expect(plan.errors).toEqual([]);
    expect(plan.cells[0]!.recipes).toEqual(['onnxruntime']);
    expect(configureFlags(data, plan.cells[0]!)).toContain('--enable-libonnxruntime');
    expect(data.ffmpeg.get('9')!['auto-components']).toContain('onnxruntime');
    expect(data.ffmpeg.get('8')!.options).not.toHaveProperty('onnxruntime');
  });
});
