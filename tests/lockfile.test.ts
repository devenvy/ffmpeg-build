import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  formatFolderLock,
  formatLock,
  type Lock,
  LockError,
  parseFolderLock,
  parseLock,
  readLock,
} from '../src/lockfile.ts';

const lock: Lock = {
  engine: '0.2.0',
  profiles: {
    playback: {
      ffmpeg: { '8': '8.1.3', '9': '9.0.2' },
      libraries: {
        'nv-codec': '13.0.19.1',
        dav1d: '1.5.4',
        libplacebo: '7.360.1',
        x264: 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55',
      },
      pinned: [
        { name: 'libplacebo', version: '7.349.0', cond: { platforms: ['win-arm64'] } },
        {
          name: 'dav1d',
          version: '1.4.3',
          cond: { ffmpeg: ['>=9'], license: ['gplv3', 'nonfree'] },
        },
      ],
    },
    live: { ffmpeg: { '9': '9.0.2' }, libraries: { srt: '1.5.7' }, pinned: [] },
  },
};

const text = `# ffmpeg.lock - written only by \`ffmpeg-build update\` / \`ffmpeg-build lock\`. Do not edit.
engine: 0.2.0
profiles:
  live:
    ffmpeg: { "9": 9.0.2 }
    libraries:
      srt: 1.5.7
  playback:
    ffmpeg: { "8": 8.1.3, "9": 9.0.2 }
    libraries:
      dav1d: 1.5.4
      libplacebo: 7.360.1
      nv-codec: 13.0.19.1
      x264: b35605ace3ddf7c1a5d67a2eb553f034aef41d55
    pinned:
      - libplacebo: { version: 7.349.0, platforms: [win-arm64] }
      - dav1d: { version: 1.4.3, ffmpeg: [">=9"], license: [gplv3, nonfree] }
`;

describe('ffmpeg.lock', () => {
  it('writes a stable, sorted layout', () => {
    expect(formatLock(lock)).toBe(text);
  });

  it('reads back exactly what it wrote', () => {
    expect(parseLock(formatLock(lock), 'ffmpeg.lock')).toEqual(lock);
  });

  it('writes an empty lock', () => {
    const empty = formatLock({ engine: '0.2.0', profiles: {} });
    expect(empty).toContain('profiles: {}');
    expect(parseLock(empty, 'ffmpeg.lock')).toEqual({ engine: '0.2.0', profiles: {} });
  });

  it('stops on a merge conflict with the line, and says how to recover', () => {
    const conflicted = text.replace(
      '    libraries:\n      srt: 1.5.7\n',
      '<<<<<<< HEAD\n    libraries: {}\n=======\n    libraries: { srt: 1.5.8 }\n>>>>>>> other\n',
    );
    expect(() => parseLock(conflicted, 'ffmpeg.lock')).toThrow(LockError);
    expect(() => parseLock(conflicted, 'ffmpeg.lock')).toThrow(
      /^ffmpeg\.lock:\d+: .*run ffmpeg-build lock/,
    );
  });

  it('names what is wrong in a hand-edited lock', () => {
    expect(() => parseLock('profiles: {}\n', 'ffmpeg.lock')).toThrow(/ffmpeg\.lock: engine: /);
  });

  it('reads a lock from disk, or nothing when there is none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-lock-'));
    expect(readLock(join(dir, 'ffmpeg.lock'))).toBeUndefined();
    writeFileSync(join(dir, 'ffmpeg.lock'), text);
    expect(readLock(join(dir, 'ffmpeg.lock'))).toEqual(lock);
  });
});

describe('the folder lock (targets)', () => {
  const folderLock = {
    engine: '0.3.0',
    ffmpeg: { '9': '9.0.2', '8': '8.1.3' },
    libraries: { x264: 'b35605ace3ddf7c1a5d67a2eb553f034aef41d55', dav1d: '1.5.4' },
  };

  it('writes one version per FFmpeg series and per library, sorted, and reads it back', () => {
    const written = formatFolderLock(folderLock);
    expect(written).toBe(
      [
        '# ffmpeg.lock - written only by `ffmpeg-build update` / `ffmpeg-build lock`. Do not edit.',
        'engine: 0.3.0',
        'ffmpeg: { "8": 8.1.3, "9": 9.0.2 }',
        'libraries:',
        '  dav1d: 1.5.4',
        '  x264: b35605ace3ddf7c1a5d67a2eb553f034aef41d55',
        '',
      ].join('\n'),
    );
    expect(parseFolderLock(written, 'ffmpeg.lock')).toEqual(folderLock);
  });

  const COMMIT = 'c'.repeat(40);
  const SHA = 'f'.repeat(64);
  const pinned = {
    ...folderLock,
    pins: { ffmpeg: { '9': { sha256: SHA } }, libraries: { dav1d: { commit: COMMIT } } },
  };

  it('pins each source’s content beside its version: a commit for a git tag, a sha256 for a tarball', () => {
    const written = formatFolderLock(pinned);
    expect(written).toBe(
      [
        '# ffmpeg.lock - written only by `ffmpeg-build update` / `ffmpeg-build lock`. Do not edit.',
        'engine: 0.3.0',
        'ffmpeg:',
        '  "8": 8.1.3',
        `  "9": { version: 9.0.2, sha256: ${SHA} }`,
        'libraries:',
        `  dav1d: { version: 1.5.4, commit: ${COMMIT} }`,
        '  x264: b35605ace3ddf7c1a5d67a2eb553f034aef41d55',
        '',
      ].join('\n'),
    );
    expect(parseFolderLock(written, 'ffmpeg.lock')).toEqual(pinned);
  });

  it('reads a lock from before pins as it was: versions only', () => {
    const old = 'engine: 0.3.0\nffmpeg: { "9": 9.0.2 }\nlibraries:\n  dav1d: 1.5.4\n';
    expect(parseFolderLock(old, 'ffmpeg.lock')).toEqual({
      engine: '0.3.0',
      ffmpeg: { '9': '9.0.2' },
      libraries: { dav1d: '1.5.4' },
    });
  });

  it('refuses a pin that is not a full commit or sha256', () => {
    expect(() =>
      parseFolderLock(
        'engine: 0.3.0\nffmpeg: {}\nlibraries:\n  dav1d: { version: 1.5.4, commit: abc123 }\n',
        'ffmpeg.lock',
      ),
    ).toThrow(/libraries\.dav1d/);
    expect(() =>
      parseFolderLock(
        'engine: 0.3.0\nffmpeg: { "9": { version: 9.0.2, sha256: abc } }\n',
        'ffmpeg.lock',
      ),
    ).toThrow(/ffmpeg\.9/);
  });

  it('refuses one FFmpeg version carrying two different pins (two series on the same release)', () => {
    const [a, b] = ['a'.repeat(64), 'b'.repeat(64)];
    const lockWith = (second: string) =>
      `engine: 0.3.0\nffmpeg:\n  "9": { version: 9.1.0, sha256: ${a} }\n  "9.1": { version: 9.1.0, sha256: ${second} }\n`;
    expect(() => parseFolderLock(lockWith(b), 'ffmpeg.lock')).toThrow(LockError);
    expect(() => parseFolderLock(lockWith(b), 'ffmpeg.lock')).toThrow(
      /FFmpeg 9\.1\.0 .*two different pins.*"9".*"9\.1"/,
    );
    expect(parseFolderLock(lockWith(a), 'ffmpeg.lock').pins!.ffmpeg).toEqual({
      '9': { sha256: a },
      '9.1': { sha256: a },
    }); // the same pin twice is fine
    // one pinned and one not is no conflict either: the pinned one says what the version is
    expect(() =>
      parseFolderLock(
        `engine: 0.3.0\nffmpeg:\n  "9": { version: 9.1.0, sha256: ${a} }\n  "9.1": 9.1.0\n`,
        'ffmpeg.lock',
      ),
    ).not.toThrow();
  });

  it('refuses one library version carrying two different pins', () => {
    const [c, d] = ['c'.repeat(40), 'd'.repeat(40)];
    expect(() =>
      parseFolderLock(
        `engine: 0.3.0\nffmpeg: {}\nlibraries:\n  dav1d: { version: 1.5.4, commit: ${c} }\n  dav1d: { version: 1.5.4, commit: ${d} }\n`,
        'ffmpeg.lock',
      ),
    ).toThrow(LockError);
    // a library pinned by both a commit and a sha256 has two pins for one version
    expect(() =>
      parseFolderLock(
        `engine: 0.3.0\nffmpeg: {}\nlibraries:\n  dav1d: { version: 1.5.4, commit: ${c}, sha256: ${'e'.repeat(64)} }\n`,
        'ffmpeg.lock',
      ),
    ).toThrow(/dav1d 1\.5\.4 .*two different pins/);
  });

  it("refuses an FFmpeg entry pinned by both a commit and a sha256, as a library's", () => {
    const both = `engine: 0.3.0\nffmpeg:\n  "9": { version: 9.1.0, commit: ${'c'.repeat(40)}, sha256: ${'e'.repeat(64)} }\n`;
    expect(() => parseFolderLock(both, 'ffmpeg.lock')).toThrow(LockError);
    expect(() => parseFolderLock(both, 'ffmpeg.lock')).toThrow(
      'ffmpeg.lock: ffmpeg.9: FFmpeg 9.1.0 has two different pins (a commit and a sha256): its source is one or the other',
    );
  });

  it('points an older lock at migrate', () => {
    expect(() => parseFolderLock('engine: 0.2.0\nprofiles: {}\n', 'ffmpeg.lock')).toThrow(
      'ffmpeg.lock predates targets (it has profiles:); run `ffmpeg-build migrate` to convert this folder',
    );
  });

  it('says how to recover from a broken lock', () => {
    expect(() => parseFolderLock('engine: 0.3.0\nlibraries: [a]\n', 'ffmpeg.lock')).toThrow(
      /delete it and run ffmpeg-build lock/,
    );
  });
});
