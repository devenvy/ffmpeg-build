import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { beginOutputs } from '../src/build-outputs.ts';
import { LockBusyError } from '../src/file-lock.ts';

const NAME = 'ffmpeg-9.0.2-linux-x64-gplv3';

/** Writes a complete artifact set, as the worker does, into `dir`, every file saying `label`. */
function writeSet(dir: string, label: string, sources = ['ffmpeg/ffmpeg-9.0.2.tar.xz']): void {
  writeFileSync(join(dir, `${NAME}.tar.gz`), label);
  writeFileSync(join(dir, `${NAME}-dev.tar.gz`), label);
  writeFileSync(join(dir, `${NAME}.sources.json`), label);
  for (const s of sources) {
    mkdirSync(join(dir, `${NAME}.sources`, s, '..'), { recursive: true });
    writeFileSync(join(dir, `${NAME}.sources`, s), label);
  }
}

describe('build outputs', () => {
  it('are built in a staging folder of their own inside --out, and swapped in whole at the end', () => {
    const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-'));
    writeSet(out, 'old', ['old/only-in-the-old-set.tar.gz']);
    const set = beginOutputs(out, NAME);
    try {
      expect(set.staging.startsWith(join(out, `.${NAME}.staging-`))).toBe(true);
      writeSet(set.staging, 'new');
      writeFileSync(set.log, 'log');
      // nothing in --out has changed yet
      expect(readFileSync(join(out, `${NAME}.tar.gz`), 'utf8')).toBe('old');
      set.commit();
    } finally {
      set.release();
    }
    for (const f of [
      `${NAME}.tar.gz`,
      `${NAME}-dev.tar.gz`,
      `${NAME}.sources.json`,
      `${NAME}.log`,
    ]) {
      expect(readFileSync(join(out, f), 'utf8')).toBe(f.endsWith('.log') ? 'log' : 'new');
    }
    expect(existsSync(join(out, `${NAME}.sources`, 'old'))).toBe(false); // the old set's sources went with it
    expect(readdirSync(out).sort()).toEqual([
      `${NAME}-dev.tar.gz`,
      `${NAME}.log`,
      `${NAME}.sources`,
      `${NAME}.sources.json`,
      `${NAME}.tar.gz`,
    ]);
  });

  it("move a build's debug symbols archive with the rest of its set", () => {
    const win = 'ffmpeg-9.0.2-win-x64-gplv3';
    const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-'));
    writeFileSync(join(out, `symbols-9.0.2-win-x64-gplv3.tar.gz`), 'old');
    writeFileSync(join(out, `symbols-9.0.2-linux-x64-gplv3.tar.gz`), 'not this artifact');
    const set = beginOutputs(out, win);
    try {
      writeFileSync(join(set.staging, `${win}.tar.gz`), 'new');
      writeFileSync(join(set.staging, `symbols-9.0.2-win-x64-gplv3.tar.gz`), 'new');
      set.commit();
    } finally {
      set.release();
    }
    expect(readFileSync(join(out, 'symbols-9.0.2-win-x64-gplv3.tar.gz'), 'utf8')).toBe('new');
    expect(readFileSync(join(out, 'symbols-9.0.2-linux-x64-gplv3.tar.gz'), 'utf8')).toBe(
      'not this artifact',
    );
    // a new set without symbols leaves none of the old set's behind
    const again = beginOutputs(out, win);
    try {
      writeFileSync(join(again.staging, `${win}.tar.gz`), 'newer');
      again.commit();
    } finally {
      again.release();
    }
    expect(existsSync(join(out, 'symbols-9.0.2-win-x64-gplv3.tar.gz'))).toBe(false);
  });

  it("keep the previous complete set when the build fails, with the failed build's log beside it", () => {
    const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-'));
    writeSet(out, 'old');
    const set = beginOutputs(out, NAME);
    writeFileSync(join(set.staging, `${NAME}.tar.gz`), 'half'); // the build died after one archive
    writeFileSync(set.log, 'failed log');
    set.abort();
    set.release();
    expect(readFileSync(join(out, `${NAME}.tar.gz`), 'utf8')).toBe('old');
    expect(readFileSync(join(out, `${NAME}-dev.tar.gz`), 'utf8')).toBe('old');
    expect(readFileSync(join(out, `${NAME}.log`), 'utf8')).toBe('failed log');
    expect(readdirSync(out).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('refuse a second build of the same artifact into the same --out while one runs', () => {
    const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-'));
    const set = beginOutputs(out, NAME);
    expect(() => beginOutputs(out, NAME)).toThrow(LockBusyError);
    beginOutputs(out, 'another-artifact').release(); // another artifact is fine
    set.release();
    beginOutputs(out, NAME).release();
  });

  it('clear what a crashed run left, and put back a set it had moved aside but not replaced', () => {
    const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-'));
    // a run died mid-swap: the old set moved aside, one new file moved in, the rest still staged
    const aside = join(out, `.${NAME}.previous-abc123`);
    mkdirSync(aside);
    writeSet(aside, 'old');
    const staged = join(out, `.${NAME}.staging-abc123`);
    mkdirSync(staged);
    writeFileSync(join(staged, `${NAME}-dev.tar.gz`), 'new');
    writeFileSync(join(out, `${NAME}.tar.gz`), 'new');
    mkdirSync(join(out, `.${NAME}.staging-def456`)); // and an earlier run's staging folder
    beginOutputs(out, NAME).release();
    for (const f of [`${NAME}.tar.gz`, `${NAME}-dev.tar.gz`, `${NAME}.sources.json`]) {
      expect(readFileSync(join(out, f), 'utf8')).toBe('old');
    }
    expect(readdirSync(out).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('leave nothing of the artifact visible after a pre-journal first build died mid-swap', () => {
    const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-'));
    // a first-ever build (nothing to set aside: its previous folder is empty) died after moving in part of its set
    mkdirSync(join(out, `.${NAME}.previous-abc123`));
    const staged = join(out, `.${NAME}.staging-abc123`);
    mkdirSync(staged);
    writeFileSync(join(staged, `${NAME}-dev.tar.gz`), 'new');
    writeFileSync(join(out, `${NAME}.tar.gz`), 'new');
    writeFileSync(join(out, `${NAME}.sources.json`), 'new');
    mkdirSync(join(out, `${NAME}.sources`));
    writeFileSync(join(out, `${NAME}.log`), 'new');
    writeFileSync(join(out, 'ffmpeg-9.0.2-linux-arm64-gplv3.tar.gz'), 'another artifact');
    beginOutputs(out, NAME).release();
    expect(readdirSync(out)).toEqual(['ffmpeg-9.0.2-linux-arm64-gplv3.tar.gz']);
  });

  it('put back exactly the old set after a pre-journal swap died, dropping a new item the old set lacked', () => {
    const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-'));
    const aside = join(out, `.${NAME}.previous-abc123`);
    mkdirSync(aside);
    writeFileSync(join(aside, `${NAME}.tar.gz`), 'old'); // the old set had no -dev archive
    mkdirSync(join(out, `.${NAME}.staging-abc123`));
    writeFileSync(join(out, `${NAME}-dev.tar.gz`), 'new'); // moved in before the run died
    beginOutputs(out, NAME).release();
    expect(readdirSync(out)).toEqual([`${NAME}.tar.gz`]);
    expect(readFileSync(join(out, `${NAME}.tar.gz`), 'utf8')).toBe('old');
  });

  it('keep the visible set when a run died before any swap began (a staging folder alone)', () => {
    const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-'));
    writeSet(out, 'old');
    const staged = join(out, `.${NAME}.staging-abc123`);
    mkdirSync(staged);
    writeFileSync(join(staged, `${NAME}.tar.gz`), 'half');
    beginOutputs(out, NAME).release();
    expect(readFileSync(join(out, `${NAME}.tar.gz`), 'utf8')).toBe('old');
    expect(readdirSync(out).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  describe('a run that dies at any step of the swap leaves, after the next run starts, one whole set', () => {
    /** The steps a swap goes through (recorded from a run that doesn't die). */
    const steps = (withOld: boolean): string[] => {
      const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-'));
      if (withOld) {
        writeSet(out, 'old');
      }
      const seen: string[] = [];
      const set = beginOutputs(out, NAME, {
        afterStep: (s) => {
          seen.push(s);
        },
      });
      writeSet(set.staging, 'new');
      writeFileSync(set.log, 'new');
      set.commit();
      set.release();
      return seen;
    };
    const visible = (out: string) =>
      readdirSync(out)
        .filter((f) => !f.startsWith('.'))
        .sort();
    const contents = (out: string) =>
      visible(out)
        .filter((f) => !f.endsWith('.sources'))
        .map((f) => readFileSync(join(out, f), 'utf8'));

    for (const withOld of [false, true]) {
      it(`${withOld ? 'replacing a set' : 'on a first build'}: at every step`, () => {
        const all = steps(withOld);
        expect(all.length).toBeGreaterThan(4);
        expect(all[0]).toBe('journal');
        for (const step of all) {
          const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-'));
          if (withOld) {
            writeSet(out, 'old');
          }
          const set = beginOutputs(out, NAME, {
            afterStep: (s) => {
              if (s === step) {
                throw new Error('crash');
              }
            },
          });
          writeSet(set.staging, 'new');
          writeFileSync(set.log, 'new');
          expect(() => set.commit(), step).toThrow('crash');
          set.release(); // the lock goes with the process; what it was swapping stays
          beginOutputs(out, NAME).release(); // the next run recovers
          const names = visible(out);
          const finished = all.indexOf(step) >= all.indexOf('moved-in');
          let wanted: string[] = []; // no lone artifact of an unfinished first build
          let wantedContents: string[] = [];
          if (finished) {
            wanted = [
              `${NAME}-dev.tar.gz`,
              `${NAME}.log`,
              `${NAME}.sources`,
              `${NAME}.sources.json`,
              `${NAME}.tar.gz`,
            ];
            wantedContents = ['new'];
          } else if (withOld) {
            wanted = [
              `${NAME}-dev.tar.gz`,
              `${NAME}.sources`,
              `${NAME}.sources.json`,
              `${NAME}.tar.gz`,
            ];
            wantedContents = ['old'];
          }
          expect(names, step).toEqual(wanted);
          expect(new Set(contents(out)), step).toEqual(new Set(wantedContents));
          expect(
            readdirSync(out).filter((f) => f.startsWith('.')),
            step,
          ).toEqual([]);
        }
      });
    }
  });

  it('finish a swap a crashed run had completed but not cleaned up', () => {
    const out = mkdtempSync(join(tmpdir(), 'ffmpeg-build-out-'));
    writeSet(out, 'new');
    const aside = join(out, `.${NAME}.previous-abc123`); // its staging folder is gone: everything had moved in
    mkdirSync(aside);
    writeSet(aside, 'old');
    beginOutputs(out, NAME).release();
    expect(readFileSync(join(out, `${NAME}.tar.gz`), 'utf8')).toBe('new');
    expect(readdirSync(out).filter((f) => f.startsWith('.'))).toEqual([]);
  });
});

describe('a swap journal in --out', () => {
  it("names only the artifact's own items: anything else (a path, another file) is not a journal to act on", () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-outputs-journal-'));
    const out = join(root, 'out');
    mkdirSync(out);
    const victim = join(root, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep'), 'keep');
    writeFileSync(join(out, 'unrelated.txt'), 'keep');
    for (const name of ['../victim', 'unrelated.txt', '/abs', 'a/b']) {
      writeFileSync(
        join(out, `.${NAME}.swap-x.json`),
        JSON.stringify({ old: [], new: [name], committed: false }),
      );
      beginOutputs(out, NAME).release();
      expect(existsSync(join(victim, 'keep')), name).toBe(true);
      expect(existsSync(join(out, 'unrelated.txt')), name).toBe(true);
      expect(existsSync(join(out, `.${NAME}.swap-x.json`)), name).toBe(false); // dropped: it moved nothing
    }
  });
});

describe('a swap journal that repeats an item, or is not a plain file', () => {
  it('is not acted on', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-outputs-journal2-'));
    const out = join(root, 'out');
    mkdirSync(out);
    writeFileSync(join(out, `${NAME}.tar.gz`), 'the good one');
    writeFileSync(
      join(out, `.${NAME}.swap-x.json`),
      JSON.stringify({ old: [], new: [`${NAME}.tar.gz`, `${NAME}.tar.gz`], committed: false }),
    );
    beginOutputs(out, NAME).release();
    expect(readFileSync(join(out, `${NAME}.tar.gz`), 'utf8')).toBe('the good one');
    // a folder of the journal's name is left alone
    mkdirSync(join(out, `.${NAME}.swap-y.json`));
    beginOutputs(out, NAME).release();
    expect(existsSync(join(out, `.${NAME}.swap-y.json`))).toBe(true);
  });
});
