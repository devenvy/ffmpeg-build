import { describe, expect, it } from 'vitest';

import { configureFlags } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);

describe('TensorFlow CPU backend', () => {
  it.each(['8', '9'])('%s gates the actual Apache/OpenSSL runtime closure', (major) => {
    for (const license of ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree']) {
      const parsed = parseProfileText(
        `name: t\nffmpeg: ${major}\nplatforms: [linux-x64]\nlicense: ${license}\nwith: [tensorflow]\n`,
        't.yml',
      );
      if (!parsed.ok) {
        throw new Error(parsed.errors.join('\n'));
      }
      const plan = planProfile(parsed.profile, data, {
        [major]: major === '8' ? '8.1.3' : '9.0.2',
      });
      expect(plan.cells[0]!.recipes.includes('tensorflow')).toBe(
        ['lgplv3', 'nonfree'].includes(license),
      );
    }
  });

  it.each(['8', '9'])('%s exposes an opt-in CPU backend with preserved build inputs', (major) => {
    const parsed = parseProfileText(
      `name: t\nffmpeg: ${major}\nplatforms: [linux-x64]\nlicense: lgplv3\nwith: [tensorflow]\n`,
      't.yml',
    );
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('\n'));
    }
    const plan = planProfile(parsed.profile, data, { [major]: major === '8' ? '8.1.3' : '9.0.2' });
    expect(plan.errors).toEqual([]);
    expect(plan.cells[0]!.recipes).toEqual(['tensorflow']);
    expect(configureFlags(data, plan.cells[0]!)).toContain('--enable-libtensorflow');
    expect(data.ffmpeg.get(major)!['auto-components']).toContain('tensorflow');
    expect(data.recipes.get('tensorflow')!.build['source-inventory']).toBe(
      'ffb-source-inputs.json',
    );
  });
});
