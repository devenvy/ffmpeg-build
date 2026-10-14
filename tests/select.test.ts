import { describe, expect, it } from 'vitest';

import { selectedNames, selectTargets } from '../src/select.ts';
import { parseFolderText } from '../src/targets.ts';

const folder = (() => {
  const r = parseFolderText(
    [
      'targets:',
      '  lin:  { platform: linux-x64,   license: lgplv3, ffmpeg: 9 }',
      '  arm:  { platform: linux-arm64, license: lgplv3, ffmpeg: 9 }',
      '  win:  { platform: win-x64,     license: lgplv3, ffmpeg: 9 }',
      '  mac:  { platform: osx-arm64,   license: lgplv3, ffmpeg: 9 }',
      '',
    ].join('\n'),
    '/f',
  );
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return r.folder;
})();
const names = (sel: Parameters<typeof selectTargets>[1]) =>
  selectTargets(folder, sel).map((t) => t.name);

describe('choosing targets', () => {
  it('takes every target when nothing is named', () => {
    expect(names({})).toEqual(['lin', 'arm', 'win', 'mac']);
    expect(selectedNames(folder, {})).toEqual({});
  });

  it('takes a list of names, in the file order', () => {
    expect(names({ target: 'win, lin' })).toEqual(['lin', 'win']);
  });

  it('takes platform patterns as the file writes them', () => {
    expect(names({ platform: 'linux-*,win-*' })).toEqual(['lin', 'arm', 'win']);
    expect(names({ platform: 'osx-arm64' })).toEqual(['mac']);
    expect(selectedNames(folder, { platform: 'linux-*' })).toEqual({ target: 'lin,arm' });
  });

  it('with both, takes the targets that match both', () => {
    expect(names({ target: 'lin,win,mac', platform: 'linux-*,osx-*' })).toEqual(['lin', 'mac']);
  });

  it('says what is wrong: an unknown name, a pattern that is no platform, nothing matching', () => {
    expect(() => names({ target: 'lin,nope' })).toThrow(
      'no target nope in ffmpeg-build.yml (targets: lin, arm, win, mac)',
    );
    expect(() => names({ platform: 'linux-x46' })).toThrow(
      '--platform: linux-x46 names no platform ffmpeg-build knows',
    );
    expect(() => names({ platform: 'android-*' })).toThrow(
      'no target matches --platform android-* (targets: lin (linux-x64), arm (linux-arm64), win (win-x64), mac (osx-arm64))',
    );
    expect(() => names({ target: ' , ' })).toThrow('--target: name at least one target');
  });
});
