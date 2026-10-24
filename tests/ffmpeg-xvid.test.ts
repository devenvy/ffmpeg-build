import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { fixXvidDelayedFrames } from '../src/build/ffmpeg-xvid.ts';

// Exact LGPL-2.1-or-later input from FFmpeg n8.0/libavcodec/libxvid.c.
// The other audited releases differ only in these upstream API/annotation edits.
const original = readFileSync(new URL('./fixtures/xvid-8.0.c.txt', import.meta.url), 'utf8');
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function release(version: string): string {
  if (version === '8.0') {
    return original;
  }
  let result = original
    .replace('#include "packet_internal.h"\n', '')
    .replace('        int pict_type;', '        enum AVPictureType pict_type;')
    .replace('ff_side_data_set_encoder_stats', 'ff_encode_add_stats_side_data');
  if (version === '9.0') {
    for (const flag of [
      'XVID_ME_EXTSEARCH8',
      'XVID_ME_CHROMA_BVOP',
      'XVID_ME_CHECKPREDICTION_RD',
      'XVID_ME_QUARTERPELREFINE16_RD',
    ]) {
      const line = result.split('\n').find((candidate) => candidate.trim() === `${flag};`);
      if (!line) {
        throw new Error(`Missing reviewed upstream annotation point: ${flag}`);
      }
      result = result.replace(`${line}\n`, `${line}\n        av_fallthrough;\n`);
    }
  }
  return result;
}
function source(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ffb-xvid-drain-'));
  directories.push(dir);
  mkdirSync(join(dir, 'libavcodec'));
  const path = join(dir, 'libavcodec', 'libxvid.c');
  writeFileSync(path, text);
  return { dir, path };
}
it.each(['8.0', '8.1', '9.0'])(
  'repairs the complete audited %s wrapper exactly once',
  (version) => {
    const before = release(version);
    const { dir, path } = source(before);
    expect(fixXvidDelayedFrames(dir, ['--enable-libxvid'])).toBe(true);
    const fixed = readFileSync(path, 'utf8');
    expect(fixed).toContain('AV_CODEC_CAP_DELAY');
    expect(fixed).toContain('picture ? XVID_CSP_PLANAR : XVID_CSP_NULL');
    expect(fixed).toContain('xvid_packet_properties(avctx, pkt)');
    expect(fixed).toContain('x->frames || x->callback_count');
    expect(fixed).toContain('i + 3 < frame_len');
    expect(fixed).not.toContain('header_len - 3');
    expect(fixed).toContain(
      version === '8.0' ? 'ff_side_data_set_encoder_stats' : 'ff_encode_add_stats_side_data',
    );
    expect(fixXvidDelayedFrames(dir, ['--enable-libxvid'])).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(fixed);
  },
);
it('does not read source when the optional encoder is disabled', () => {
  expect(fixXvidDelayedFrames('missing-ffmpeg-source', [])).toBe(false);
});
it.each([
  original.replace('int mpeg_quant;', 'int changed_quant;'),
  original.replace('plugins[4]', 'plugins[5]'),
  `${original}\n/* unreviewed wrapper change */\n`,
])('rejects changed or partially repaired source before writing', (before) => {
  const { dir, path } = source(before);
  expect(() => fixXvidDelayedFrames(dir, ['--enable-libxvid'])).toThrow(
    /Unsupported libxvid wrapper/,
  );
  expect(readFileSync(path, 'utf8')).toBe(before);
});
it('accepts the audited source with Windows line endings', () => {
  const { dir, path } = source(original.replaceAll('\n', '\r\n'));
  expect(fixXvidDelayedFrames(dir, ['--enable-libxvid'])).toBe(true);
  expect(readFileSync(path, 'utf8')).toContain('AV_CODEC_CAP_DELAY');
});
