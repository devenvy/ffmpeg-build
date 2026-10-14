// Staging copies a library's symlinks as they are, as cp -a did: FFmpeg's install makes relative links
// (libavformat.so.63 -> libavformat.so.63.1.102), and an absolute one would point out of the archive.
import { mkdirSync, mkdtempSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { copyContents, copyMatches } from '../src/build/stage.ts';

describe.skipIf(process.platform === 'win32')('staging', () => {
  it('keeps relative symlinks relative', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-stage-links-'));
    const lib = join(root, 'install', 'lib');
    mkdirSync(lib, { recursive: true });
    writeFileSync(join(lib, 'libavformat.so.63.1.102'), 'elf');
    symlinkSync('libavformat.so.63.1.102', join(lib, 'libavformat.so.63'));
    copyContents(lib, join(root, 'run'));
    expect(readlinkSync(join(root, 'run', 'libavformat.so.63'))).toBe('libavformat.so.63.1.102');
    copyMatches(join(lib, '*.so*'), join(root, 'dev'));
    expect(readlinkSync(join(root, 'dev', 'libavformat.so.63'))).toBe('libavformat.so.63.1.102');
  });
});
