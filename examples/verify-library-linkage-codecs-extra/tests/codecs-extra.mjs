import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-codecs-extra-'));
const FLAGS = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
const WIDTH = 128;
const HEIGHT = 128;
const FRAMES = 8;
const FPS = 8;
const RATE = 8000;
const SAMPLE_BYTES = 4;
const MAX_PIXEL_ERROR = 25;
const MIN_POWER = 0.0001;
const MAX_POWER = 0.3;
const TIMEOUT = 120000;
const MAX_OUTPUT = 4194304;
const run = (program, args, input) => {
  const result = spawnSync(program, args, { input, timeout: TIMEOUT, maxBuffer: MAX_OUTPUT });
  assert.equal(
    result.status,
    0,
    `${program} ${args.join(' ')}: signal=${result.signal}; ${result.error?.message ?? ''}\n${result.stderr?.toString()}`,
  );
  return result.stdout;
};
const ff = (args, input) => run(ffmpeg, [...FLAGS, ...args], input);
try {
  const source = ff([
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}`,
    '-frames:v',
    String(FRAMES),
    '-pix_fmt',
    'yuv420p',
    '-f',
    'rawvideo',
    '-',
  ]);
  for (const [encoder, decoder, format, options] of [
    [
      'libkvazaar',
      'hevc',
      'hevc',
      ['-kvazaar-params', 'preset=ultrafast,threads=2,owf=0,qp=22,gop=0'],
    ],
    ['libxavs2', 'libdavs2', 'avs2', ['-speed_level', '0', '-bf', '0']],
  ]) {
    const encoded = join(work, `authored.${format}`);
    console.log(`Testing ${encoder}/${decoder}`);
    ff(
      [
        '-f',
        'rawvideo',
        '-pixel_format',
        'yuv420p',
        '-video_size',
        `${WIDTH}x${HEIGHT}`,
        '-framerate',
        String(FPS),
        '-i',
        '-',
        '-c:v',
        encoder,
        ...options,
        '-f',
        format,
        encoded,
      ],
      source,
    );
    // Decode through EOF without limiting frames, so both loss and duplication fail.
    const decoded = ff([
      '-c:v',
      decoder,
      '-i',
      encoded,
      '-map',
      '0:v:0',
      '-pix_fmt',
      'yuv420p',
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-',
    ]);
    assert.equal(
      decoded.length,
      source.length,
      `${encoder}/${decoder}: every authored frame through EOF`,
    );
    let difference = 0;
    for (let offset = 0; offset < source.length; offset++) {
      difference += Math.abs(decoded[offset] - source[offset]);
    }
    const error = difference / source.length;
    assert.ok(error < MAX_PIXEL_ERROR, `${encoder}/${decoder}: pixel error ${error}`);
    console.log(`${encoder}/${decoder}: all ${FRAMES} frames and authored pixels passed`);
  }
  const speech = ff([
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=0.2*sin(2*PI*120*t)+0.1*sin(2*PI*240*t):s=${RATE}:d=1`,
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    '-f',
    's16le',
    '-',
  ]);
  const encodedSpeech = join(work, 'authored.c2');
  ff(
    [
      '-f',
      's16le',
      '-ar',
      String(RATE),
      '-ac',
      '1',
      '-i',
      '-',
      '-c:a',
      'libcodec2',
      '-mode',
      '3200',
      '-f',
      'codec2',
      encodedSpeech,
    ],
    speech,
  );
  const audio = ff(['-c:a', 'libcodec2', '-i', encodedSpeech, '-f', 'f32le', '-']);
  assert.equal(audio.length, RATE * SAMPLE_BYTES, 'Codec2 must return every authored sample');
  let power = 0;
  for (let offset = 0; offset < audio.length; offset += SAMPLE_BYTES) {
    const sample = audio.readFloatLE(offset);
    assert.ok(Number.isFinite(sample));
    power += sample * sample;
  }
  power /= RATE;
  assert.ok(power > MIN_POWER && power < MAX_POWER, `Codec2 decoded power ${power}`);
  const files = readdirSync(dirname(ffmpeg));
  const dynamic = files
    .filter((name) => /\.so(?:\.|$)/.test(name))
    .map((name) => run('readelf', ['-d', join(dirname(ffmpeg), name)]).toString())
    .join('\n');
  for (const name of ['codec2', 'kvazaar', 'xavs2', 'davs2']) {
    const bundled = files.some((file) => new RegExp(`^lib${name}\\.so`).test(file));
    assert.equal(
      new RegExp(`NEEDED.*lib${name}\\.so`).test(dynamic),
      bundled,
      `${name}: selected linkage`,
    );
  }
  for (const name of files.filter((file) => /^libdavs2\.so(?:\.|$)/.test(file))) {
    const file = join(dirname(ffmpeg), name);
    assert.doesNotMatch(run('readelf', ['-d', file]).toString(), /NEEDED.*libstdc\+\+/);
    assert.doesNotMatch(
      run('nm', ['-D', '--defined-only', file]).toString(),
      /\b(?:_Z(?:St|N[KVO]?St|T[ISV]St)|__cxa_|_Unwind_)\w+/,
    );
  }
  console.log('Codec2 authored speech, selected ELF dependencies and private C++ exports passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
