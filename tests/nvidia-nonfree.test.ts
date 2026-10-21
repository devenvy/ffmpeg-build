import { describe, expect, it } from 'vitest';

import { configureFlags } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);
const planOn = (major: string, license: string, options: string) => {
  const parsed = parseProfileText(
    `name: t\nffmpeg: ${major}\nplatforms: [linux-x64]\nlicense: ${license}\nwith: [${options}]\n`,
    't.yml',
  );
  if (!parsed.ok) {
    throw new Error(parsed.errors.join('\n'));
  }
  return planProfile(parsed.profile, data, { [major]: major === '8' ? '8.1.3' : '9.0.2' });
};

describe('NVIDIA nonfree options', () => {
  it.each(['8', '9'])(
    '%s enables nvcc with a compiler in the actual dependency folder',
    (major) => {
      const plan = planOn(major, 'nonfree', 'cuda-nvcc');
      expect(plan.errors).toEqual([]);
      expect(plan.cells[0]!.recipes).toEqual(
        expect.arrayContaining(['cuda-nvcc', 'cuda-runtime', 'nv-codec']),
      );
      expect(configureFlags(data, plan.cells[0]!, '/native/deps')).toEqual(
        expect.arrayContaining(['--enable-cuda-nvcc', '--nvcc=/native/deps/bin/nvcc']),
      );
    },
  );

  it('does not offer the NPP backend removed in FFmpeg 9', () => {
    expect(data.ffmpeg.get('8')!.options).not.toHaveProperty('npp');
    expect(data.ffmpeg.get('9')!.options).not.toHaveProperty('npp');
  });

  it.each(['lgplv2', 'lgplv3', 'gplv2', 'gplv3'])(
    'excludes the proprietary libraries from %s',
    (license) => {
      expect(planOn('8', license, 'cuda-nvcc').cells.flatMap((c) => c.options)).not.toContain(
        'cuda-nvcc',
      );
    },
  );
});
