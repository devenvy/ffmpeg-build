import { describe, expect, it } from 'vitest';

import { configureFlags } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);
describe('Torch CPU backend', () => {
  it.each(['8', '9'])(
    '%s gates its Apache-licensed dependency closure to compatible profiles',
    (major) => {
      for (const license of ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree']) {
        const parsed = parseProfileText(
          `name: t\nffmpeg: ${major}\nplatforms: [linux-x64]\nlicense: ${license}\nwith: [torch]\n`,
          't.yml',
        );
        if (!parsed.ok) {
          throw new Error(parsed.errors.join('\n'));
        }
        const plan = planProfile(parsed.profile, data, {
          [major]: major === '8' ? '8.1.3' : '9.0.2',
        });
        expect(plan.cells[0]!.recipes.includes('torch')).toBe(
          ['lgplv3', 'gplv3', 'nonfree'].includes(license),
        );
      }
    },
  );
  it.each(['8', '9'])('%s offers opt-in native TorchScript inference', (major) => {
    const parsed = parseProfileText(
      `name: t\nffmpeg: ${major}\nplatforms: [linux-x64]\nlicense: lgplv3\nwith: [torch]\n`,
      't.yml',
    );
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('\n'));
    }
    const plan = planProfile(parsed.profile, data, { [major]: major === '8' ? '8.1.3' : '9.0.2' });
    expect(plan.errors).toEqual([]);
    expect(plan.cells[0]!.recipes).toEqual(['torch']);
    expect(configureFlags(data, plan.cells[0]!)).toContain('--enable-libtorch');
    expect(data.ffmpeg.get(major)!['auto-components']).toContain('torch');
  });
});
