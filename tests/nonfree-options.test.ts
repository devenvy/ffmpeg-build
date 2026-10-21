import { describe, expect, it } from 'vitest';

import { configureFlags } from '../src/build/plan.ts';
import { optionFacts } from '../src/commands/options.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { PLATFORMS } from '../src/platforms.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);

const planOn = (major: string, platform: string, license: string) => {
  const parsed = parseProfileText(
    `name: t\nffmpeg: ${major}\nplatforms: [${platform}]\nlicense: ${license}\nwith: [fdk-aac, mpeghdec]\n`,
    't.yml',
  );
  if (!parsed.ok) {
    throw new Error(parsed.errors.join('\n'));
  }
  return planProfile(parsed.profile, data, { [major]: major === '8' ? '8.1.3' : '9.0.2' });
};
const builds = ['8', '9'].flatMap((major) =>
  PLATFORMS.map((platform) => [major, platform] as const),
);

describe('nonfree audio options', () => {
  it.each(builds)('%s on %s links both libraries together', (major, platform) => {
    const plan = planOn(major, platform, 'nonfree');
    expect(plan.errors).toEqual([]);
    expect(plan.cells[0]!.recipes).toEqual(expect.arrayContaining(['fdk-aac', 'mpeghdec']));
    expect(configureFlags(data, plan.cells[0]!)).toEqual(
      expect.arrayContaining(['--enable-libfdk-aac', '--enable-libmpeghdec']),
    );
  });
  it.each(builds)('%s on %s excludes both from distributable builds', (major, platform) => {
    for (const license of ['lgplv2', 'lgplv3', 'gplv2', 'gplv3']) {
      const options = planOn(major, platform, license).cells.flatMap((c) => c.options);
      expect(options).not.toContain('fdk-aac');
      expect(options).not.toContain('mpeghdec');
    }
  });
  it.each(['8', '9'])('%s offers both as nonfree and brings their codecs', (major) => {
    for (const name of ['fdk-aac', 'mpeghdec']) {
      expect(optionFacts(data, major).find((o) => o.name === name)?.licenses).toEqual(['nonfree']);
      expect(data.ffmpeg.get(major)!['auto-components']).toContain(name);
    }
  });
});
