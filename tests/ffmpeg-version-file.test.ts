import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { unshadowVersionHeader } from '../src/build/ffmpeg.ts';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
  dirs = [];
});
const source = (files: Record<string, string>) => {
  const d = mkdtempSync(join(tmpdir(), 'ffb-ffmpeg-src-'));
  dirs.push(d);
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(d, name), text);
  }
  return d;
};

// FFmpeg's release tarball has a VERSION file at its root, and FFmpeg compiles with -I.: on Apple's case-insensitive
// file system, libc++'s `#include <version>` finds it, so no C++ source of FFmpeg's compiles there (the ocio filter's
// ocio_wrapper.cpp; devenvy/ffmpeg-build#41). FFmpeg after 9.0 names the file FF_VERSION (upstream 72e5fc4b80).
describe("FFmpeg's VERSION file on Apple", () => {
  it.each(['apple-macos', 'apple-ios'])(
    '%s: is removed, as RELEASE says the same version (what version.sh reads next)',
    (setup) => {
      const dir = source({ VERSION: '9.0.2\n', RELEASE: '9.0.2\n' });
      expect(unshadowVersionHeader(dir, setup)).toBe(true);
      expect(existsSync(join(dir, 'VERSION'))).toBe(false);
      expect(readFileSync(join(dir, 'RELEASE'), 'utf8')).toBe('9.0.2\n');
    },
  );

  it('stops the build when RELEASE would give FFmpeg another version', () => {
    const dir = source({ VERSION: '9.0.2\n', RELEASE: '9.0.2-dev\n' });
    expect(() => unshadowVersionHeader(dir, 'apple-macos')).toThrow(
      "FFmpeg's VERSION (9.0.2) and RELEASE (9.0.2-dev) differ: without VERSION, which shadows libc++'s <version> on Apple, its version would be RELEASE's",
    );
    expect(existsSync(join(dir, 'VERSION'))).toBe(true);
  });

  it('is left alone elsewhere, and when the source has none (a newer FFmpeg: FF_VERSION)', () => {
    for (const setup of ['linux', 'linux-musl', 'windows', 'android']) {
      const dir = source({ VERSION: '9.0.2\n', RELEASE: '9.0.2\n' });
      expect(unshadowVersionHeader(dir, setup)).toBe(false);
      expect(existsSync(join(dir, 'VERSION'))).toBe(true);
    }
    expect(unshadowVersionHeader(source({ FF_VERSION: '10.0\n' }), 'apple-macos')).toBe(false);
  });
});
