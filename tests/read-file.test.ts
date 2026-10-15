// src/read-file.ts: reading a file that may be absent, or must be a plain file, by opening it once (no check of the
// path before the read for the file to change in between).
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readFileIfPresent, readPlainFile } from '../src/read-file.ts';

const dir = (): string => mkdtempSync(join(tmpdir(), 'ffmpeg-build-read-file-'));

/** A symbolic link, where the system lets this user make one (Windows needs developer mode). */
function link(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
}

describe('readFileIfPresent', () => {
  it("is the file's text, or undefined when there is none", () => {
    const d = dir();
    writeFileSync(join(d, 'a'), 'text');
    expect(readFileIfPresent(join(d, 'a'))).toBe('text');
    expect(readFileIfPresent(join(d, 'missing'))).toBeUndefined();
  });

  it('throws for anything else that stops the read', () => {
    const d = dir();
    mkdirSync(join(d, 'folder'));
    expect(() => readFileIfPresent(join(d, 'folder'))).toThrow(/EISDIR|EPERM/);
  });
});

describe('readPlainFile', () => {
  it("is a plain file's text, and undefined for a folder or a missing path", () => {
    const d = dir();
    writeFileSync(join(d, 'a'), 'text');
    mkdirSync(join(d, 'folder'));
    expect(readPlainFile(join(d, 'a'))).toBe('text');
    expect(readPlainFile(join(d, 'folder'))).toBeUndefined();
    expect(readPlainFile(join(d, 'missing'))).toBeUndefined();
  });

  it('is undefined for a file larger than the limit', () => {
    const d = dir();
    writeFileSync(join(d, 'a'), '12345');
    expect(readPlainFile(join(d, 'a'), { maxBytes: 4 })).toBeUndefined();
    expect(readPlainFile(join(d, 'a'), { maxBytes: 5 })).toBe('12345');
  });

  it('follows a link unless told not to', () => {
    const d = dir();
    writeFileSync(join(d, 'a'), 'text');
    if (!link(join(d, 'a'), join(d, 'l'))) {
      return;
    }
    expect(readPlainFile(join(d, 'l'))).toBe('text');
    expect(readPlainFile(join(d, 'l'), { noFollow: true })).toBeUndefined();
  });
});
