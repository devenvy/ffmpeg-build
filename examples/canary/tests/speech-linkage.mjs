import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const TIMEOUT = 30000;
const SAMPLE_BYTES = 4;
const MIN_DURATION = 0.9;
const MAX_DURATION = 1.2;
const MIN_POWER = 0.00001;
const MAX_POWER = 0.1;
const VIDEO_WIDTH = 64;
const VIDEO_HEIGHT = 64;
const VIDEO_CHANNELS = 3;
const FRAME_COUNT = 5;
const MAX_PIXEL_ERROR = 35;
const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-speech-linkage-'));
const command = (args) => {
  const result = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
    timeout: TIMEOUT,
  });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
};
const cases = [
  {
    encoder: 'libopencore_amrnb',
    decoder: 'libopencore_amrnb',
    rate: 8000,
    bitrate: '12.2k',
    extension: 'amr',
  },
  {
    encoder: 'libvo_amrwbenc',
    decoder: 'libopencore_amrwb',
    rate: 16000,
    bitrate: '23.85k',
    extension: 'amr',
  },
  { encoder: 'libilbc', decoder: 'libilbc', rate: 8000, mode: 20, extension: 'lbc' },
  { encoder: 'libilbc', decoder: 'libilbc', rate: 8000, mode: 30, extension: 'lbc' },
];
try {
  for (const { encoder, decoder, rate, bitrate, mode, extension } of cases) {
    const encoded = join(work, `${encoder}-${mode ?? 'default'}.${extension}`);
    command([
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=997:sample_rate=${rate}:duration=1`,
      '-ac',
      '1',
      '-c:a',
      encoder,
      ...(bitrate ? ['-b:a', bitrate] : []),
      ...(mode ? ['-mode', String(mode)] : []),
      encoded,
    ]);
    const decoded = command([
      '-c:a',
      decoder,
      '-i',
      encoded,
      '-ar',
      String(rate),
      '-ac',
      '1',
      '-f',
      'f32le',
      '-',
    ]);
    assert.equal(decoded.length % SAMPLE_BYTES, 0);
    const samples = decoded.length / SAMPLE_BYTES;
    assert.ok(samples / rate >= MIN_DURATION && samples / rate <= MAX_DURATION);
    let power = 0;
    for (let offset = 0; offset < decoded.length; offset += SAMPLE_BYTES) {
      const sample = decoded.readFloatLE(offset);
      assert.ok(Number.isFinite(sample));
      power += sample * sample;
    }
    power /= samples;
    assert.ok(power > MIN_POWER && power < MAX_POWER, `${encoder}: signal power ${power}`);
    console.log(`${encoder}${mode ? ` mode ${mode}` : ''} -> ${decoder} round trip passed`);
  }
  const source = `testsrc=size=${VIDEO_WIDTH}x${VIDEO_HEIGHT}:rate=${FRAME_COUNT}:duration=1`;
  const original = command([
    '-f',
    'lavfi',
    '-i',
    source,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ]);
  const encoded = join(work, 'theora.ogv');
  command([
    '-f',
    'lavfi',
    '-i',
    source,
    '-c:v',
    'libtheora',
    '-q:v',
    '7',
    '-pix_fmt',
    'yuv420p',
    encoded,
  ]);
  const decoded = command([
    '-c:v',
    'theora',
    '-i',
    encoded,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ]);
  assert.equal(original.length, VIDEO_WIDTH * VIDEO_HEIGHT * VIDEO_CHANNELS * FRAME_COUNT);
  assert.equal(decoded.length, original.length);
  let error = 0;
  for (let offset = 0; offset < decoded.length; offset++) {
    error += Math.abs(decoded[offset] - original[offset]);
  }
  assert.ok(
    error / decoded.length < MAX_PIXEL_ERROR,
    'Theora frames must retain the authored test pattern',
  );
  console.log('libtheora -> theora video round trip passed');
  const ilbc = join(dirname(ffmpeg), 'libilbc.so.3');
  if (existsSync(ilbc)) {
    const dynamic = spawnSync('readelf', ['-d', ilbc], { encoding: 'utf8', timeout: TIMEOUT });
    assert.equal(dynamic.status, 0, dynamic.stderr);
    assert.ok(
      !/NEEDED.*libstdc\+\+/.test(dynamic.stdout),
      'Shared iLBC must retain its private C++ runtime',
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
