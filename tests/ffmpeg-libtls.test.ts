import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fixLibtlsFallthrough } from '../src/build/ffmpeg.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
const source = (text: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'ffb-libtls-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'libavformat'));
  writeFileSync(join(dir, 'libavformat', 'tls_libtls.c'), text);
  return dir;
};
const invalid = 'err_ctx:\n    ret = AVERROR(EIO);\n    av_fallthrough;\nfail:\n    return ret;\n';

describe('libtls error labels', () => {
  it('repairs the invalid fallthrough attribute only for the selected backend', () => {
    const dir = source(invalid);
    expect(fixLibtlsFallthrough(dir, ['--enable-openssl'])).toBe(false);
    expect(readFileSync(join(dir, 'libavformat', 'tls_libtls.c'), 'utf8')).toBe(invalid);
    expect(fixLibtlsFallthrough(dir, ['--enable-libtls'])).toBe(true);
    expect(readFileSync(join(dir, 'libavformat', 'tls_libtls.c'), 'utf8')).not.toContain(
      'av_fallthrough;',
    );
    expect(fixLibtlsFallthrough(dir, ['--enable-libtls'])).toBe(false);
  });

  it('leaves FFmpeg 8 and corrected upstream sources unchanged', () => {
    for (const text of [
      invalid.replace('av_fallthrough;', '/* fallthrough */'),
      invalid.replace('    av_fallthrough;\n', ''),
    ]) {
      const dir = source(text);
      expect(fixLibtlsFallthrough(dir, ['--enable-libtls'])).toBe(false);
      expect(readFileSync(join(dir, 'libavformat', 'tls_libtls.c'), 'utf8')).toBe(text);
    }
  });
});
