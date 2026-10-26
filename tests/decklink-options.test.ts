import { describe, expect, it } from 'vitest';

import { configureFlags } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);
const planOn = (major: string, platform: string, license: string) => {
  const parsed = parseProfileText(
    `name: t\nffmpeg: ${major}\nplatforms: [${platform}]\nlicense: ${license}\nwith: [decklink]\n`,
    't.yml',
  );
  if (!parsed.ok) {
    throw new Error(parsed.errors.join('\n'));
  }
  return planProfile(parsed.profile, data, { [major]: major === '8' ? '8.1.3' : '9.0.2' });
};

describe('DeckLink', () => {
  it.each(['8', '9'])('%s enables the device and VANC where its runtime exists', (major) => {
    for (const platform of ['linux-x64']) {
      const plan = planOn(major, platform, 'nonfree');
      expect(plan.errors).toEqual([]);
      expect(plan.cells[0]!.recipes).toEqual(
        expect.arrayContaining(['decklink-headers', 'libklvanc']),
      );
      expect(configureFlags(data, plan.cells[0]!)).toEqual(
        expect.arrayContaining(['--enable-decklink', '--enable-libklvanc']),
      );
    }
    const windows = planOn(major, 'win-x64', 'nonfree');
    expect(windows.cells[0]!.recipes).toContain('decklink-headers');
    expect(windows.cells[0]!.recipes).not.toContain('libklvanc');
    expect(configureFlags(data, windows.cells[0]!)).toContain('--enable-decklink');
    expect(configureFlags(data, windows.cells[0]!)).not.toContain('--enable-libklvanc');
    expect(configureFlags(data, windows.cells[0]!, '/native/deps')).toContain(
      '--extra-cxxflags=-I/native/deps/include',
    );
  });

  it.each(['osx-arm64', 'osx-x64'])(
    'omits the unsupported stock SDK/FFmpeg callback combination on %s',
    (platform) => {
      for (const major of ['8', '9']) {
        const plan = planOn(major, platform, 'nonfree');
        expect(plan.cells.flatMap((cell) => cell.options)).not.toContain('decklink');
        expect(configureFlags(data, plan.cells[0]!)).not.toContain('--enable-decklink');
      }
    },
  );

  it.each(['lgplv2', 'lgplv3', 'gplv2', 'gplv3'])('cannot enter a %s build', (license) => {
    expect(planOn('9', 'linux-x64', license).cells.flatMap((c) => c.options)).not.toContain(
      'decklink',
    );
  });
});
