import { describe, expect, it } from 'vitest';

import { configureFlags } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);
describe('OpenVINO CPU inference', () => {
  it.each(['8', '9'])('%s offers static CPU inference under version 3 profiles', (major) => {
    for (const license of ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree']) {
      const parsed = parseProfileText(
        `name: t\nffmpeg: ${major}\nplatforms: [linux-x64]\nlicense: ${license}\nwith: [openvino]\n`,
        't.yml',
      );
      if (!parsed.ok) {
        throw new Error(parsed.errors.join('\n'));
      }
      const plan = planProfile(parsed.profile, data, {
        [major]: major === '8' ? '8.1.3' : '9.0.2',
      });
      const allowed = ['lgplv3', 'gplv3', 'nonfree'].includes(license);
      expect(plan.cells[0]!.recipes.includes('openvino')).toBe(allowed);
    }
  });

  it.each(['8', '9'])(
    '%s enables OpenVINO and keeps its components in restricted targets',
    (major) => {
      const parsed = parseProfileText(
        `name: t\nffmpeg: ${major}\nplatforms: [linux-x64]\nlicense: lgplv3\nwith: [openvino]\n`,
        't.yml',
      );
      if (!parsed.ok) {
        throw new Error(parsed.errors.join('\n'));
      }
      const plan = planProfile(parsed.profile, data, {
        [major]: major === '8' ? '8.1.3' : '9.0.2',
      });
      expect(plan.errors).toEqual([]);
      expect(configureFlags(data, plan.cells[0]!)).toContain('--enable-libopenvino');
      expect(data.ffmpeg.get(major)!['auto-components']).toContain('openvino');
    },
  );
});
