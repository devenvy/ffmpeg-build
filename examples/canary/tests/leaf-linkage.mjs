import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT = 30000;
const MAX_BUFFER = 8_388_608;
const RGB_CHANNELS = 3;
const BLUE_OFFSET = 2;
const YUV_420_10_BYTES_PER_PIXEL = 3;
const SAMPLE_BYTES = 4;
const SAMPLE_RATE = 48000;
const MIN_DURATION = 0.1;
const MAX_DURATION = 0.4;
const MIN_POWER = 0.0001;
const MAX_POWER = 0.1;
const SIDE = 64;
const FRAME_COUNT = 3;
const work = mkdtempSync(join(tmpdir(), 'ffb-leaf-linkage-'));
const run = (args) => {
  const result = spawnSync(process.env.FFMPEG, ['-hide_banner', '-nostdin', ...args], {
    timeout: TIMEOUT,
    maxBuffer: MAX_BUFFER,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result;
};
const source = `testsrc2=size=${SIDE}x${SIDE}:rate=${FRAME_COUNT}:duration=1`;
const raw = (input, format, frames = FRAME_COUNT) =>
  run([...input, '-frames:v', String(frames), '-pix_fmt', format, '-f', 'rawvideo', '-']).stdout;

try {
  const wave = join(work, 'input.wav');
  // The LC3 reference-file header needs the input's known sample count. A finite
  // WAV supplies it; lavfi reports an unknown stream duration even for a finite sine.
  run(['-f', 'lavfi', '-i', `sine=frequency=997:sample_rate=${SAMPLE_RATE}:duration=0.2`, wave]);
  for (const [encoder, decoder, extension, rate] of [
    ['libtwolame', 'mp2', 'mp2', '128k'],
    ['liblc3', 'liblc3', 'lc3', '64k'],
  ]) {
    const path = join(work, `audio.${extension}`);
    run(['-i', wave, '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', encoder, '-b:a', rate, path]);
    const pcm = run(['-c:a', decoder, '-i', path, '-f', 'f32le', '-']).stdout;
    const samples = pcm.length / SAMPLE_BYTES;
    const duration = samples / SAMPLE_RATE;
    assert.ok(duration >= MIN_DURATION && duration <= MAX_DURATION, `${encoder}: ${duration}s`);
    let power = 0;
    for (let offset = 0; offset < pcm.length; offset += SAMPLE_BYTES) {
      const sample = pcm.readFloatLE(offset);
      assert.ok(Number.isFinite(sample));
      power += sample * sample;
    }
    power /= samples;
    assert.ok(power >= MIN_POWER && power <= MAX_POWER, `${encoder}: invalid audio ${power}`);
    console.log(`${encoder}: real encode/decode with non-silent audio`);
  }

  for (const [encoder, decoder, format, extra] of [
    ['libvpx', 'libvpx', 'yuv420p', ['-deadline', 'realtime', '-cpu-used', '8']],
    [
      'libvpx-vp9',
      'libvpx-vp9',
      'yuv420p10le',
      ['-lossless', '1', '-deadline', 'realtime', '-cpu-used', '8'],
    ],
  ]) {
    const input = `${source},format=${format}`;
    const path = join(work, `${encoder}.ivf`);
    run([
      '-f',
      'lavfi',
      '-i',
      input,
      '-frames:v',
      String(FRAME_COUNT),
      '-c:v',
      encoder,
      ...extra,
      path,
    ]);
    const expected = raw(['-f', 'lavfi', '-i', input], format);
    const actual = raw(['-c:v', decoder, '-i', path], format);
    assert.equal(actual.length, expected.length);
    assert.ok(actual.some((byte) => byte !== 0));
    if (encoder === 'libvpx-vp9') {
      assert.deepEqual(actual, expected, 'lossless ten-bit VP9 pixels changed');
    }
    console.log(`${encoder}/${decoder}: ${format} encode/decode`);
  }

  const jpeg = join(work, 'openjpeg.jp2');
  run([
    '-f',
    'lavfi',
    '-i',
    `${source},format=rgb24`,
    '-frames:v',
    '1',
    '-c:v',
    'libopenjpeg',
    '-irreversible',
    '0',
    '-numresolution',
    '4',
    jpeg,
  ]);
  assert.deepEqual(
    raw(['-i', jpeg], 'rgb24', 1),
    raw(['-f', 'lavfi', '-i', `${source},format=rgb24`], 'rgb24', 1),
    'lossless OpenJPEG pixels changed',
  );
  console.log('libopenjpeg: lossless RGB round trip');

  const alphaSource = `color=c=0x33669980:size=${SIDE}x${SIDE}:rate=1,format=bgra`;
  const webp = join(work, 'alpha.webp');
  run([
    '-f',
    'lavfi',
    '-i',
    alphaSource,
    '-frames:v',
    '1',
    '-c:v',
    'libwebp',
    '-lossless',
    '1',
    webp,
  ]);
  assert.deepEqual(
    raw(['-i', webp], 'bgra', 1),
    raw(['-f', 'lavfi', '-i', alphaSource], 'bgra', 1),
  );
  const animation = join(work, 'animation.webp');
  run([
    '-f',
    'lavfi',
    '-i',
    source,
    '-frames:v',
    String(FRAME_COUNT),
    '-c:v',
    'libwebp_anim',
    '-lossless',
    '1',
    '-loop',
    '0',
    animation,
  ]);
  const animatedBytes = readFileSync(animation);
  assert.ok(
    animatedBytes.includes(Buffer.from('ANIM')) && animatedBytes.includes(Buffer.from('ANMF')),
  );
  console.log('libwebp: lossless alpha round trip; libwebp_anim: real animated output');

  const WIDTH = 48;
  const HEIGHT = 32;
  const resized = raw(
    ['-f', 'lavfi', '-i', source, '-vf', `zscale=w=${WIDTH}:h=${HEIGHT},format=yuv420p10le`],
    'yuv420p10le',
    1,
  );
  assert.equal(resized.length, WIDTH * HEIGHT * YUV_420_10_BYTES_PER_PIXEL);
  assert.ok(new Set(resized).size > 1);
  console.log('zimg: zscale resize and ten-bit depth conversion');

  const sizes = {};
  for (const compressor of ['none', 'snappy']) {
    const path = join(work, `hap-${compressor}.mov`);
    run([
      '-f',
      'lavfi',
      '-i',
      `color=red:size=${SIDE}x${SIDE}:rate=1`,
      '-frames:v',
      '1',
      '-c:v',
      'hap',
      '-compressor',
      compressor,
      path,
    ]);
    const decoded = raw(['-i', path], 'rgb24', 1);
    assert.equal(decoded.length, SIDE * SIDE * RGB_CHANNELS);
    const MIN_RED = 240;
    const MAX_OTHER = 10;
    for (let offset = 0; offset < decoded.length; offset += RGB_CHANNELS) {
      assert.ok(
        decoded[offset] >= MIN_RED &&
          decoded[offset + 1] <= MAX_OTHER &&
          decoded[offset + BLUE_OFFSET] <= MAX_OTHER,
      );
    }
    sizes[compressor] = statSync(path).size;
  }
  assert.ok(sizes.snappy < sizes.none, 'HAP did not use Snappy compression');
  console.log('snappy: compressed HAP is smaller and decodes to the expected pixels');

  const payload = 'ffb-linkage-qr';
  const qr = run([
    '-f',
    'lavfi',
    '-i',
    `color=white:size=320x320:rate=1,qrencode=text=${payload}:q=256:Q=288:x=16:y=16,quirc,metadata=print`,
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ]);
  assert.ok(
    qr.stderr.toString().includes(`lavfi.quirc.0.payload=${payload}`),
    qr.stderr.toString(),
  );
  console.log('libqrencode: QR payload recovered exactly through quirc');
} finally {
  rmSync(work, { recursive: true, force: true });
}
