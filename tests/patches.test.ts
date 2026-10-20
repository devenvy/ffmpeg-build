import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureData, fixtureProfilesDir } from './helpers.ts';
import { plannedPatches } from '../src/build/plan.ts';
import { checkProfile, profileAdditions } from '../src/check.ts';
import { formatReport } from '../src/format.ts';
import { loadProfile } from '../src/profile.ts';

const data = fixtureData();

/** A profile folder with one patch set: `about` is its about.yml, `majors` the folders it has. */
function folder(license: string, about: string, majors: string[], ffmpeg = '[8, 9]'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-patches-'));
  for (const m of majors) {
    mkdirSync(join(dir, 'patches', 'acme-muxer', m), { recursive: true });
  }
  mkdirSync(join(dir, 'patches', 'acme-muxer'), { recursive: true });
  writeFileSync(join(dir, 'patches', 'acme-muxer', 'about.yml'), about);
  writeFileSync(join(dir, 'patches', 'acme-muxer', 'LICENSE'), 'Acme licence\n');
  writeFileSync(
    join(dir, 'p.yml'),
    `name: p\nffmpeg: ${ffmpeg}\nplatforms: [linux-x64]\nlicense: ${license}\nwith: [dav1d]\npatches: [patches/acme-muxer]\n`,
  );
  return join(dir, 'p.yml');
}
const check = (file: string) => formatReport(checkProfile(loadProfile(file), data));
const proprietary = (majors: string) =>
  `name: acme-muxer\nlicense: proprietary\nlicense-files: [LICENSE]\nffmpeg: ${majors}\n`;

describe('patch sets', () => {
  it('must be a folder inside the profile folder', () => {
    const file = folder('nonfree', proprietary('[8, 9]'), ['8', '9']);
    writeFileSync(
      file,
      'name: p\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: nonfree\nwith: [dav1d]\npatches: [../shared/acme]\n',
    );
    expect(check(file)).toContain(
      "✗ patches: ../shared/acme: a patch set must be a folder inside this one (it goes into the release's sources archive at the same path)",
    );
  });

  it('needs nonfree for a proprietary patch set', () => {
    const text = check(folder('lgplv3', proprietary('[8, 9]'), ['8', '9']));
    expect(text).toContain(
      '✗ patches: patches/acme-muxer: acme-muxer is `license: proprietary`; it can only be built with `license: nonfree`',
    );
    expect(text).toContain('Fix: license: nonfree, or relicense the patch set.');
  });

  it('accepts a proprietary patch set in a nonfree profile', () => {
    expect(check(folder('nonfree', proprietary('[8, 9]'), ['8', '9']))).not.toContain('patches:');
  });

  it('follows licenses.yml for an SPDX licence', () => {
    const text = check(
      folder(
        'lgplv3',
        'name: acme-muxer\nlicense: GPL-2.0-or-later\nlicense-files: [LICENSE]\nffmpeg: [8, 9]\n',
        ['8', '9'],
      ),
    );
    expect(text).toContain('it can only be built with `license: gplv2, gplv3, nonfree`');
  });

  it('needs the patch set to declare every FFmpeg major the profile builds', () => {
    const text = check(folder('nonfree', proprietary('9'), ['8', '9']));
    expect(text).toContain(
      '✗ patches: patches/acme-muxer: about.yml declares FFmpeg 9 only; this profile also builds FFmpeg 8',
    );
  });

  it('needs a folder of patches for every FFmpeg major the profile builds', () => {
    const text = check(folder('nonfree', proprietary('[8, 9]'), ['9']));
    expect(text).toContain(
      '✗ patches: patches/acme-muxer: no patches for FFmpeg 8 (add a 8/ folder)',
    );
  });

  it('says when a patch folder has no about.yml', () => {
    const file = folder('nonfree', proprietary('[8, 9]'), ['8', '9']);
    writeFileSync(
      file,
      'name: p\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: nonfree\nwith: [dav1d]\npatches: [patches/nope]\n',
    );
    expect(check(file)).toContain('✗ patches: patches/nope: no about.yml there');
  });

  it('says what is wrong with an about.yml', () => {
    expect(check(folder('nonfree', 'name: acme-muxer\nffmpeg: 9\n', ['9'], '9'))).toContain(
      '✗ patches: patches/acme-muxer: about.yml: license: ',
    );
  });

  it("passes studio.yml's own patch set", () => {
    expect(check(join(fixtureProfilesDir, 'studio.yml'))).not.toContain('patches:');
  });
});

describe('about.yml values', () => {
  it('needs the licence files it names, in the patch folder', () => {
    const about = (files: string) => `name: acme-muxer\nlicense: proprietary\n${files}ffmpeg: 9\n`;
    expect(
      check(folder('nonfree', about('license-files: [LICENSE, NOTICE]\n'), ['9'], '9')),
    ).toContain(
      '✗ patches: patches/acme-muxer: about.yml: license-files: NOTICE is not in the patch folder',
    );
    expect(check(folder('nonfree', about(''), ['9'], '9'))).toContain(
      '✗ patches: patches/acme-muxer: about.yml: license-files: ',
    );
    expect(check(folder('nonfree', about('license-files: [../LICENSE]\n'), ['9'], '9'))).toContain(
      'about.yml: license-files[0]: expected a relative path inside the folder',
    );
  });

  it('says ffmpeg: takes FFmpeg majors', () => {
    expect(
      check(
        folder(
          'nonfree',
          'name: acme-muxer\nlicense: proprietary\nlicense-files: [LICENSE]\nffmpeg: ["9.0"]\n',
          ['9'],
          '9',
        ),
      ),
    ).toContain(
      '✗ patches: patches/acme-muxer: about.yml: ffmpeg: 9.0 is not an FFmpeg major; write 9',
    );
  });

  describe('what a set adds (adds:)', () => {
    const adds = (list: string) =>
      `name: acme-muxer\nlicense: proprietary\nlicense-files: [LICENSE]\nffmpeg: 9\nadds: ${list}\n`;
    /** check, the target restricting these kinds */
    const checkWith = (file: string, components: Record<string, string[]>) => {
      const loaded = loadProfile(file);
      if (!loaded.ok) {
        throw new Error(loaded.errors.join('\n'));
      }
      return formatReport(
        checkProfile({ ...loaded, profile: { ...loaded.profile, components } }, data),
      );
    };

    it("lets components: name what a set it applies adds, FFmpeg's own spelling or not", () => {
      const file = folder(
        'nonfree',
        adds('{ demuxers: [acme], decoders: [{ adpcm_acme: { listed-as: acme_adpcm } }] }'),
        ['9'],
        '9',
      );
      expect(
        checkWith(file, { demuxers: ['mov', 'acme'], decoders: ['h264', 'adpcm_acme'] }),
      ).not.toContain('✗');
    });

    it('gives the build what each set adds, for configure', () => {
      const file = folder(
        'nonfree',
        adds('{ demuxers: [acme], decoders: [{ adpcm_acme: { listed-as: acme_adpcm } }] }'),
        ['9'],
        '9',
      );
      const loaded = loadProfile(file);
      if (!loaded.ok) {
        throw new Error(loaded.errors.join('\n'));
      }
      expect(plannedPatches(loaded.profile, '9')[0]!.adds).toEqual({
        decoders: ['adpcm_acme'],
        demuxers: ['acme'],
      });
      expect(profileAdditions(loaded.profile).names.decoders).toEqual({ adpcm_acme: 'acme_adpcm' });
    });

    it('refuses those names for a target without the set', () => {
      const file = folder('nonfree', proprietary('9'), ['9'], '9');
      expect(checkWith(file, { demuxers: ['mov', 'acme'] })).toContain(
        "FFmpeg 9 has no demuxer called acme (it's spelled as configure lists it",
      );
    });

    it('refuses an addition FFmpeg already has, and a kind that is not one', () => {
      expect(check(folder('nonfree', adds('{ demuxers: [mov, acme] }'), ['9'], '9'))).toContain(
        '✗ patches: patches/acme-muxer: about.yml: adds: FFmpeg 9 already has a demuxer called mov',
      );
      expect(check(folder('nonfree', adds('{ codecs: [acme] }'), ['9'], '9'))).toContain(
        '✗ patches: patches/acme-muxer: about.yml: adds',
      );
    });
  });
});
