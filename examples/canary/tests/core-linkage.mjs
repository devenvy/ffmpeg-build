import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Self-generated 1x1 RGB TIFF, LZMA/XZ-compressed pixel [11,22,33]. FFmpeg's
// encoder does not write this compression mode, so retain this tiny input fixture.
const LZMA_TIFF =
  '49492a00080000000a0000010400010000000100000001010400010000000100000002010300030000008600000003010300010000006d88000006010300010000000200000011010400010000008c00000015010300010000000300000016010400010000000100000017010400010000003c0000001c010300010000000100000000000000080008000800fd377a585a000004e6d6b4460200210116000000742fe5a30100020b162100005ee13c0c321690c100011b030b2fb9101fb6f37d010000000004595a';
const FRAME_COUNT = 2;
const dir = mkdtempSync(join(tmpdir(), 'ffb-core-link-'));
const run = (args) => {
  const result = spawnSync(process.env.FFMPEG, ['-hide_banner', '-nostdin', ...args], {
    timeout: 60000,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
try {
  const av1 = join(dir, 'video.ivf');
  run([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=32x32:rate=1',
    '-frames:v',
    String(FRAME_COUNT),
    '-c:v',
    'libaom-av1',
    '-cpu-used',
    '8',
    '-threads',
    '1',
    av1,
  ]);
  const decoded = run(['-c:v', 'libdav1d', '-i', av1, '-f', 'framemd5', '-']);
  assert.equal(decoded.split('\n').filter((line) => line.startsWith('0,')).length, FRAME_COUNT);

  const png = join(dir, 'image.png');
  run([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=16x16:rate=1',
    '-frames:v',
    '1',
    '-threads',
    '1',
    '-update',
    '1',
    png,
  ]);
  run(['-i', png, '-f', 'null', '-']);
  const tiff = join(dir, 'lzma.tiff');
  const rgb = join(dir, 'pixel.rgb');
  writeFileSync(tiff, Buffer.from(LZMA_TIFF, 'hex'));
  run(['-i', tiff, '-pix_fmt', 'rgb24', '-f', 'rawvideo', rgb]);
  assert.deepEqual(readFileSync(rgb), Buffer.from('0b1621', 'hex'));

  run([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=0.1',
    '-af',
    'bs2b,aresample=16000:resampler=soxr',
    '-f',
    'null',
    '-',
  ]);
  console.log('AOM encode/dav1d decode, zlib PNG, LZMA TIFF, bs2b and soxr passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
