import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { beginOutputs } from '../src/build-outputs.ts';

const NAME = 'ffmpeg-9.0.2-linux-x64-gplv3';
const TRANSIENT_FAILURES = 2;
const MAX_EXPECTED_ATTEMPTS = 20;
const FILES = [
  `${NAME}.tar.gz`,
  `${NAME}-dev.tar.gz`,
  `${NAME}.sources.json`,
  `${NAME}.spdx.json`,
  `${NAME}.log`,
];

function writeSet(folder: string, value: string): void {
  for (const file of FILES) {
    writeFileSync(join(folder, file), value);
  }
  mkdirSync(join(folder, `${NAME}.sources`));
  writeFileSync(join(folder, `${NAME}.sources`, 'input.tar.gz'), value);
}

const contents = (folder: string): string[] =>
  [...FILES, `${NAME}.sources/input.tar.gz`].map((file) =>
    readFileSync(join(folder, file), 'utf8'),
  );

describe('build output journal replacement', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'survives transient %s without removing the old journal',
    (code) => {
      const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-journal-'));
      writeSet(out, 'old');
      const snapshots: string[] = [];
      const set = beginOutputs(out, NAME, {
        renameJournal(from, to) {
          const candidate = JSON.parse(readFileSync(from, 'utf8')) as { committed: boolean };
          if (candidate.committed && snapshots.length < TRANSIENT_FAILURES) {
            snapshots.push(readFileSync(to, 'utf8'));
            throw Object.assign(new Error('sharing violation'), { code });
          }
          renameSync(from, to);
        },
      });
      try {
        writeSet(set.staging, 'new');
        set.commit();
      } finally {
        set.release();
      }
      expect(snapshots).toHaveLength(TRANSIENT_FAILURES);
      expect(
        snapshots.map((snapshot) => (JSON.parse(snapshot) as { committed: boolean }).committed),
      ).toEqual([false, false]);
      expect(contents(out)).toEqual([...FILES, 'source'].map(() => 'new'));
      expect(readdirSync(out).some((file) => file.startsWith('.'))).toBe(false);
    },
  );

  it('bounds persistent sharing failures and restores the whole previous set', () => {
    const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-journal-'));
    writeSet(out, 'old');
    let attempts = 0;
    const set = beginOutputs(out, NAME, {
      renameJournal(from, to) {
        const candidate = JSON.parse(readFileSync(from, 'utf8')) as { committed: boolean };
        if (candidate.committed) {
          attempts++;
          throw Object.assign(new Error('persistent sharing violation'), { code: 'EACCES' });
        }
        renameSync(from, to);
      },
    });
    try {
      writeSet(set.staging, 'new');
      expect(() => set.commit()).toThrow('persistent sharing violation');
    } finally {
      set.release();
    }
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThan(MAX_EXPECTED_ATTEMPTS);
    expect(contents(out)).toEqual([...FILES, 'source'].map(() => 'old'));
  });

  it('fails immediately on another I/O error and restores the previous set', () => {
    const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-journal-'));
    writeSet(out, 'old');
    let attempts = 0;
    const set = beginOutputs(out, NAME, {
      renameJournal(from, to) {
        const candidate = JSON.parse(readFileSync(from, 'utf8')) as { committed: boolean };
        if (candidate.committed) {
          attempts++;
          throw Object.assign(new Error('broken device'), { code: 'EIO' });
        }
        renameSync(from, to);
      },
    });
    try {
      writeSet(set.staging, 'new');
      expect(() => set.commit()).toThrow('broken device');
    } finally {
      set.release();
    }
    expect(attempts).toBe(1);
    expect(contents(out)).toEqual([...FILES, 'source'].map(() => 'old'));
  });
});
