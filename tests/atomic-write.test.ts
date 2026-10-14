import {
  existsSync,
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

import { swapFiles, writeFileAtomic } from '../src/atomic-write.ts';
import { stageAndSwap, WriteError } from '../src/commands/versions.ts';
import { editFile } from '../src/profile-edit.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'ffmpeg-build-atomic-'));

describe('writing a user file', () => {
  it('goes through a temporary file of its own in the same folder, renamed into place', () => {
    const d = dir();
    const path = join(d, 'ffmpeg.version');
    writeFileSync(path, 'old\n');
    const seen: string[] = [];
    writeFileAtomic(path, 'new\n', {
      beforeRename: (temp) => {
        seen.push(temp);
        expect(readFileSync(path, 'utf8')).toBe('old\n');
      },
    });
    expect(readFileSync(path, 'utf8')).toBe('new\n');
    expect(seen[0]).toMatch(/[\\/]\.ffmpeg\.version\.[0-9a-f]+\.tmp$/);
    expect(readdirSync(d)).toEqual(['ffmpeg.version']);
  });

  it('leaves the file as it was when the write fails', () => {
    const d = dir();
    const path = join(d, 'x.yml');
    writeFileSync(path, 'old');
    expect(() =>
      writeFileAtomic(path, 'new', {
        beforeRename: () => {
          throw new Error('disk full');
        },
      }),
    ).toThrow('disk full');
    expect(readFileSync(path, 'utf8')).toBe('old');
    expect(readdirSync(d)).toEqual(['x.yml']);
  });

  it('profile edits are written that way', () => {
    const d = dir();
    const path = join(d, 'ffmpeg-build.yml');
    writeFileSync(
      path,
      'targets:\n  t: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [dav1d] }\n',
    );
    editFile(path, (t) => t.replace('[dav1d]', '[dav1d, opus]'));
    expect(readFileSync(path, 'utf8')).toContain('[dav1d, opus]');
    expect(readdirSync(d)).toEqual(['ffmpeg-build.yml']);
  });
});

describe('writing several files together', () => {
  it('puts every earlier one back when a later one fails, and says nothing changed', () => {
    const d = dir();
    writeFileSync(join(d, 'ffmpeg.lock'), 'old lock');
    let renames = 0;
    // 1 the lock aside, 2 the new lock in, 3 the summary in: fails
    const rename = (from: string, to: string) => {
      if (++renames === 3) {
        throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      }
      renameSync(from, to);
    };
    expect(() =>
      swapFiles(
        [
          { path: join(d, 'ffmpeg.lock'), text: 'new lock' },
          { path: join(d, 'summary.md'), text: 'new' },
        ],
        { rename },
      ),
    ).toThrow(/Nothing was changed\.$/);
    expect(readFileSync(join(d, 'ffmpeg.lock'), 'utf8')).toBe('old lock');
    expect(readdirSync(d)).toEqual(['ffmpeg.lock']);
  });

  it("never moves a folder that is in a file's way: nothing is written", () => {
    const d = dir();
    writeFileSync(join(d, 'ffmpeg.lock'), 'old lock');
    mkdirSync(join(d, 'summary.md'));
    writeFileSync(join(d, 'summary.md', 'x'), 'a folder in the way');
    expect(() =>
      stageAndSwap([
        { path: join(d, 'ffmpeg.lock'), text: 'new lock' },
        { path: join(d, 'summary.md'), text: 'new' },
      ]),
    ).toThrow(/summary\.md: a folder is in the way\. Nothing was written\.$/);
    expect(readFileSync(join(d, 'ffmpeg.lock'), 'utf8')).toBe('old lock');
    expect(readFileSync(join(d, 'summary.md', 'x'), 'utf8')).toBe('a folder in the way');
    expect(readdirSync(d).sort()).toEqual(['ffmpeg.lock', 'summary.md']);
  });

  it("says so when it can't put one back, and where its previous text is", () => {
    const d = dir();
    writeFileSync(join(d, 'a'), 'old a');
    writeFileSync(join(d, 'b'), 'old b');
    let renames = 0;
    const err = (() => {
      try {
        swapFiles(
          [
            { path: join(d, 'a'), text: 'new a' },
            { path: join(d, 'b'), text: 'new b' },
          ],
          {
            rename: (from, to) => {
              renames++;
              // 1 a aside, 2 a in, 3 b aside, 4 b in fails; 5 b back, 6 a back fails too
              if (renames === 4 || renames === 6) {
                throw Object.assign(new Error('in use'), { code: 'EBUSY' });
              }
              renameSync(from, to);
            },
          },
        );
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(WriteError);
    expect(err!.message).toMatch(/couldn't put back .*a: its previous text is in .*\.bak/);
    expect(err!.message).not.toMatch(/Nothing was changed/);
    const backup = readdirSync(d).find((f) => f.endsWith('.bak'))!;
    expect(readFileSync(join(d, backup), 'utf8')).toBe('old a');
    expect(existsSync(join(d, 'b'))).toBe(true);
  });
});
