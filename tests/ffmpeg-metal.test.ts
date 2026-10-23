import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { fixMetalAutorelease } from '../src/build/ffmpeg-metal.ts';

const affected = readFileSync(new URL('./fixtures/metal-affected.txt', import.meta.url), 'utf8');
const fixed = readFileSync(new URL('./fixtures/metal-fixed.txt', import.meta.url), 'utf8');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function source(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ffb-metal-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'libavfilter'));
  const path = join(dir, 'libavfilter', 'vf_yadif_videotoolbox.m');
  // Owned references must still be released; only call_kernel's borrowed values change.
  const tail = '\nstatic void do_uninit(void) { ff_objc_release(&s->mtlQueue); }\n';
  writeFileSync(path, text + tail);
  return { dir, path, tail };
}

it('backports the exact upstream ownership fix and preserves owned-reference teardown', () => {
  const { dir, path, tail } = source(affected);
  expect(fixMetalAutorelease(dir, ['--enable-metal'])).toBe(true);
  expect(readFileSync(path, 'utf8')).toBe(fixed + tail);
  expect(fixMetalAutorelease(dir, ['--enable-metal'])).toBe(false);
});

it('does not read or change FFmpeg sources when Metal is not selected', () => {
  const { dir, path, tail } = source(affected);
  expect(fixMetalAutorelease(dir, ['--enable-videotoolbox'])).toBe(false);
  expect(readFileSync(path, 'utf8')).toBe(affected + tail);
  expect(fixMetalAutorelease('/missing/source', [])).toBe(false);
});

it('recognizes the upstream-fixed implementation without writing it', () => {
  const { dir, path, tail } = source(fixed);
  expect(fixMetalAutorelease(dir, ['--enable-metal'])).toBe(false);
  expect(readFileSync(path, 'utf8')).toBe(fixed + tail);
});

it.each([
  affected.replace('buffer commit', 'buffer enqueue'),
  fixed.replace('@autoreleasepool', '@synchronized(self)'),
])('rejects an unreviewed implementation before writing any source', (text) => {
  const { dir, path, tail } = source(text);
  expect(() => fixMetalAutorelease(dir, ['--enable-metal'])).toThrow(/Metal.*unrecognized/);
  expect(readFileSync(path, 'utf8')).toBe(text + tail);
});
