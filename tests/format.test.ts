import { describe, expect, it } from 'vitest';

import { fixtureData } from './helpers.ts';
import { checkProfile, type ProfileReport } from '../src/check.ts';
import { formatPlan, formatReport, formatSummary, planJson, problemLines } from '../src/format.ts';
import { parseProfileText, type Profile } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

import type { LockedProfile } from '../src/lockfile.ts';

const data = fixtureData();
function profile(text: string): Profile {
  const r = parseProfileText(text, 't.yml');
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return r.profile;
}

/** A report with a line of each kind: there, reported (with a note), and a problem with its fix. */
const mixed: ProfileReport = {
  file: 't.yml',
  header: 't.yml   (ffmpeg: 9, platforms: [linux-x64, win-x64], license: gplv3)',
  blocks: [
    { lines: [{ mark: '✓', text: 'ffmpeg: 9 (9.1.0)' }] },
    {
      title: 'with: nvenc',
      lines: [
        { mark: '✓', text: 'available on FFmpeg 9, linux-x64' },
        { mark: '-', text: 'not on win-x64', note: 'no NVIDIA SDK there' },
      ],
    },
    {
      title: 'with: x265',
      lines: [
        {
          mark: '✗',
          text: 'lgplv3: x265 is GPL-only',
          detail: ['Remove it, or add a license it allows: gplv2, gplv3, nonfree'],
        },
      ],
    },
  ],
  problems: 1,
};

describe('a check report', () => {
  it('in full, shows every block and line under the header, and counts the problems', () => {
    expect(formatReport(mixed)).toBe(
      [
        mixed.header,
        '  ✓ ffmpeg: 9 (9.1.0)',
        '  with: nvenc',
        '    ✓ available on FFmpeg 9, linux-x64',
        '    - not on win-x64   (no NVIDIA SDK there)',
        '  with: x265',
        '    ✗ lgplv3: x265 is GPL-only',
        '        Remove it, or add a license it allows: gplv2, gplv3, nonfree',
        '',
        '1 problem in t.yml.',
      ].join('\n'),
    );
  });

  it('in full, counts several problems, and none when there are none', () => {
    expect(formatReport({ ...mixed, problems: 2 })).toMatch(/\n\n2 problems in t\.yml\.$/);
    expect(formatReport({ ...mixed, problems: 0 })).not.toMatch(/problem/);
  });

  it('in short, is one ✓ line when everything is there', () => {
    const ok: ProfileReport = { ...mixed, blocks: [mixed.blocks[0]!], problems: 0 };
    expect(formatSummary(ok)).toBe(`✓ ${mixed.header}`);
  });

  it('in short, keeps only the - and ✗ lines, each with its block’s title', () => {
    expect(formatSummary(mixed)).toBe(
      [
        `✗ ${mixed.header}`,
        '    - with: nvenc: not on win-x64   (no NVIDIA SDK there)',
        '    ✗ with: x265: lgplv3: x265 is GPL-only',
        '        Remove it, or add a license it allows: gplv2, gplv3, nonfree',
      ].join('\n'),
    );
  });

  it('in short, is headed - when what it shows is only reported, not a problem', () => {
    const reported: ProfileReport = { ...mixed, blocks: mixed.blocks.slice(0, 2), problems: 0 };
    expect(formatSummary(reported).split('\n')[0]).toBe(`- ${mixed.header}`);
  });

  it('as problem lines, has one per ✗: its block, its text and its fix', () => {
    expect(problemLines(mixed)).toEqual([
      'with: x265: lgplv3: x265 is GPL-only: Remove it, or add a license it allows: gplv2, gplv3, nonfree',
    ]);
  });

  it('as problem lines, reads the same from a real check', () => {
    const report = checkProfile(
      parseProfileText(
        'name: t\nplatforms: [linux-x64]\nffmpeg: 9\nlicense: lgplv3\nwith: [x265, frobnicate]\n',
        't.yml',
      ),
      data,
    );
    expect(problemLines(report)).toEqual([
      'with: frobnicate: ffmpeg-build doesn\'t know "frobnicate". Use the name FFmpeg gives it, like nvenc, x265 or whisper.',
      "with: x265: lgplv3: x265 is GPL-only (FFmpeg's own classification): Remove it, or add a license it allows: gplv2, gplv3, nonfree",
    ]);
    expect(formatSummary(report).split('\n')).toHaveLength(5);
  });
});

describe('a plan', () => {
  const pinned = profile(
    `name: t
platforms: [linux-x64, linux-arm64, win-x64]
ffmpeg: 9
license: gplv3
with: [dav1d, x265, { nvenc: { platforms: [linux-x64] } }]
pin:
  - dav1d: { version: "1.4", platforms: [linux-*] }
  - x265: "4.1"
`,
  );
  const locked: LockedProfile = {
    ffmpeg: {},
    libraries: { dav1d: '1.5.4', x265: 'a'.repeat(40) },
    pinned: [{ name: 'dav1d', version: '1.4.3', cond: { platforms: ['linux-*'] } }],
  };

  it('shows each build’s options, libraries and pins, one row per platform that differs', () => {
    expect(formatPlan(pinned, planProfile(pinned, data), data)).toBe(
      [
        't.yml',
        '  FFmpeg 9 (9.1.0) · gplv3',
        '    linux-x64',
        '      options:   dav1d, nvenc, x265',
        '      libraries: dav1d, nv-codec, x265',
        '      pinned:    dav1d 1.4, x265 4.1',
        '    linux-arm64',
        '      options:   dav1d, x265',
        '      libraries: dav1d, x265',
        '      pinned:    dav1d 1.4, x265 4.1',
        '    win-x64',
        '      options:   dav1d, x265',
        '      libraries: dav1d, x265',
        '      pinned:    x265 4.1',
      ].join('\n'),
    );
  });

  it('with a lock, gives each library its locked version: a conditional pin’s own, a short commit, ? when none', () => {
    const text = formatPlan(pinned, planProfile(pinned, data), data, locked);
    expect(text).toContain('libraries: dav1d 1.4.3, nv-codec ?, x265 aaaaaaaaaaaa');
    expect(text).toContain(
      '    win-x64\n      options:   dav1d, x265\n      libraries: dav1d 1.5.4, x265 aaaaaaaaaaaa',
    );
  });

  it('puts platforms that build the same in one row, and says when a build has no libraries', () => {
    const bare = profile(
      'name: t\nplatforms: [linux-x64, linux-arm64]\nffmpeg: [8, 9]\nlicense: lgplv3\n',
    );
    expect(formatPlan(bare, planProfile(bare, data), data)).toBe(
      [
        't.yml',
        '  FFmpeg 8 (8.1.3) · lgplv3',
        '    linux-x64, linux-arm64',
        "      options:   (FFmpeg's built-ins only)",
        '      libraries: (none)',
        '  FFmpeg 9 (9.1.0) · lgplv3',
        '    linux-x64, linux-arm64',
        "      options:   (FFmpeg's built-ins only)",
        '      libraries: (none)',
      ].join('\n'),
    );
  });

  it('labels a latest build by the major it is', () => {
    const latest = profile('name: t\nplatforms: [linux-x64]\nffmpeg: latest\nlicense: lgplv3\n');
    expect(formatPlan(latest, planProfile(latest, data), data).split('\n')[1]).toBe(
      '  FFmpeg 9 (9.1.0) · lgplv3',
    );
  });

  it('as JSON, has one build per platform, with versions only when there is a lock', () => {
    const plan = planProfile(pinned, data);
    const json = planJson(pinned, plan, data);
    expect(json.profile).toBe('t');
    expect(json.file).toBe('t.yml');
    expect(json.builds[0]).toEqual({
      ffmpeg: '9.1.0',
      series: '9',
      license: 'gplv3',
      platform: 'linux-x64',
      options: ['dav1d', 'nvenc', 'x265'],
      libraries: ['dav1d', 'nv-codec', 'x265'],
      pinned: { dav1d: '1.4', x265: '4.1' },
    });
    expect(json.builds.map((b) => b.platform)).toEqual(['linux-x64', 'linux-arm64', 'win-x64']);
    // a commit stays whole in JSON
    expect(planJson(pinned, plan, data, locked).builds.map((b) => b.versions)).toEqual([
      { dav1d: '1.4.3', 'nv-codec': '?', x265: 'a'.repeat(40) },
      { dav1d: '1.4.3', x265: 'a'.repeat(40) },
      { dav1d: '1.5.4', x265: 'a'.repeat(40) },
    ]);
  });
});
