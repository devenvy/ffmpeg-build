import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-specialized-'));
const TIMEOUT = 120000;
const MAX_OUTPUT = 16777216;
const RATE = 48000;
const FLOAT_BYTES = 4;
const WIDTH = 128;
const HEIGHT = 128;
const FRAMES = 4;
const FPS = 4;
const CHROMA_DIVISOR = 2;
const SAMPLE_BYTES = 2;
const TEN_BIT_SCALE = 4;
const TWO_PI = Math.PI + Math.PI;
const TONE = 440;
const AMPLITUDE = 0.3;
const HARMONIC_AMPLITUDE = 0.1;
const LOW_LUMA = 64;
const LUMA_LEVELS = 64;
const NEUTRAL_CHROMA = 128;
const PIXEL_ERROR = 12;
const MIN_POWER = 0.005;
const MAX_POWER = 0.2;
const AAC_MIN_SECONDS = 1;
const AAC_MAX_SECONDS = 1.2;
const FLAGS = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
const run = (program, args, input) => {
  const result = spawnSync(program, args, { input, timeout: TIMEOUT, maxBuffer: MAX_OUTPUT });
  assert.deepEqual(
    { status: result.status, signal: result.signal },
    { status: 0, signal: null },
    `${program} ${args.join(' ')}: ${result.error?.message ?? result.stderr?.toString()}`,
  );
  return result.stdout;
};
const ff = (args, input) => run(ffmpeg, [...FLAGS, ...args], input);
const compare = (actual, expected, bytes) => {
  assert.equal(actual.length, expected.length, 'Every authored frame must decode through EOF');
  let absoluteError = 0;
  for (let offset = 0; offset < actual.length; offset += bytes) {
    const observed = bytes === SAMPLE_BYTES ? actual.readUInt16LE(offset) : actual[offset];
    const reference = bytes === SAMPLE_BYTES ? expected.readUInt16LE(offset) : expected[offset];
    absoluteError += Math.abs(observed - reference);
  }
  const error = absoluteError / (actual.length / bytes);
  assert.ok(error < PIXEL_ERROR, `Authored pixel mean absolute error ${error}`);
  console.log(`All ${FRAMES} frames decoded; pixel error ${error}`);
};
try {
  const speech = Buffer.alloc(RATE * FLOAT_BYTES);
  for (let sample = 0; sample < RATE; sample++) {
    const angle = (TWO_PI * TONE * sample) / RATE;
    speech.writeFloatLE(
      AMPLITUDE * Math.sin(angle) + HARMONIC_AMPLITUDE * Math.sin(angle + angle),
      sample * FLOAT_BYTES,
    );
  }
  for (const profile of ['aac_low', 'aac_he']) {
    // ADTS retains encoder priming and padding, avoiding MOV edit-list trimming.
    const encoded = join(work, `${profile}.aac`);
    ff(
      [
        '-f',
        'f32le',
        '-ar',
        String(RATE),
        '-ac',
        '1',
        '-i',
        '-',
        '-c:a',
        'libfdk_aac',
        '-profile:a',
        profile,
        '-b:a',
        '64k',
        encoded,
      ],
      speech,
    );
    const decoded = ff([
      '-c:a',
      'libfdk_aac',
      '-i',
      encoded,
      '-map',
      '0:a:0',
      '-ar',
      String(RATE),
      '-ac',
      '1',
      '-f',
      'f32le',
      '-',
    ]);
    assert.equal(decoded.length % FLOAT_BYTES, 0);
    const samples = decoded.length / FLOAT_BYTES;
    const seconds = samples / RATE;
    assert.ok(seconds >= AAC_MIN_SECONDS && seconds <= AAC_MAX_SECONDS, `${profile}: ${seconds}s`);
    let energy = 0;
    for (let offset = 0; offset < decoded.length; offset += FLOAT_BYTES) {
      const value = decoded.readFloatLE(offset);
      assert.ok(Number.isFinite(value));
      energy += value * value;
    }
    const power = energy / samples;
    assert.ok(power > MIN_POWER && power < MAX_POWER, `${profile}: ${power}`);
    console.log(`FDK ${profile}: complete ${samples} samples, finite power ${power}`);
  }

  const lumaSize = WIDTH * HEIGHT;
  const frameSamples = lumaSize + lumaSize / CHROMA_DIVISOR + lumaSize / CHROMA_DIVISOR;
  const planar = Buffer.alloc(frameSamples * FRAMES);
  for (let frame = 0; frame < FRAMES; frame++) {
    const base = frame * frameSamples;
    planar.fill(NEUTRAL_CHROMA, base, base + frameSamples);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        planar[base + y * WIDTH + x] = LOW_LUMA + ((x + y + frame) % LUMA_LEVELS);
      }
    }
  }
  const tenBit = Buffer.alloc(planar.length * SAMPLE_BYTES);
  for (let sample = 0; sample < planar.length; sample++) {
    tenBit.writeUInt16LE(planar[sample] * TEN_BIT_SCALE, sample * SAMPLE_BYTES);
  }
  const apv = join(work, 'authored.mov');
  ff(
    [
      '-f',
      'rawvideo',
      '-pixel_format',
      'yuv422p10le',
      '-video_size',
      `${WIDTH}x${HEIGHT}`,
      '-framerate',
      String(FPS),
      '-i',
      '-',
      '-c:v',
      'liboapv',
      '-preset',
      'fastest',
      '-qp',
      '8',
      apv,
    ],
    tenBit,
  );
  compare(
    ff([
      '-c:v',
      'apv',
      '-i',
      apv,
      '-map',
      '0:v:0',
      '-pix_fmt',
      'yuv422p10le',
      '-f',
      'rawvideo',
      '-',
    ]),
    tenBit,
    SAMPLE_BYTES,
  );

  const sequence = join(work, 'frame-%02d.jxs');
  ff(
    [
      '-f',
      'rawvideo',
      '-pixel_format',
      'yuv422p',
      '-video_size',
      `${WIDTH}x${HEIGHT}`,
      '-framerate',
      String(FPS),
      '-i',
      '-',
      '-c:v',
      'libsvtjpegxs',
      '-b:v',
      '512k',
      '-f',
      'image2',
      sequence,
    ],
    planar,
  );
  assert.equal(readdirSync(work).filter((name) => /^frame-\d+\.jxs$/.test(name)).length, FRAMES);
  compare(
    ff([
      '-f',
      'image2',
      '-framerate',
      String(FPS),
      '-c:v',
      'libsvtjpegxs',
      '-i',
      sequence,
      '-map',
      '0:v:0',
      '-pix_fmt',
      'yuv422p',
      '-f',
      'rawvideo',
      '-',
    ]),
    planar,
    1,
  );

  const positive = ff([
    '-f',
    'lavfi',
    '-i',
    'qrencodesrc=text=FFB-QUIRC-12:q=210:Q=290:rate=1,format=gray,quirc,metadata=mode=print:file=-',
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ]).toString();
  assert.match(positive, /lavfi\.quirc\.count=1/);
  assert.match(positive, /lavfi\.quirc\.0\.payload=FFB-QUIRC-12/);
  const negative = ff([
    '-f',
    'lavfi',
    '-i',
    'color=white:s=128x128:r=1,format=gray,quirc,metadata=mode=add:key=ffb.frame:value=blank,metadata=mode=print:file=-',
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ]).toString();
  assert.match(negative, /ffb\.frame=blank/);
  assert.doesNotMatch(negative, /lavfi\.quirc\.(?:count=[1-9]|\d+\.payload=)/);
  console.log('Quirc positive payload and blank-image negative passed');

  const files = readdirSync(dirname(ffmpeg));
  const dynamic = files
    .filter((name) => /\.so(?:\.|$)/.test(name))
    .map((name) => run('readelf', ['-d', join(dirname(ffmpeg), name)]).toString())
    .join('\n');
  for (const library of ['fdk-aac', 'oapv', 'SvtJpegxs', 'quirc']) {
    const expression = new RegExp(`lib${library}\\.so`);
    assert.equal(
      new RegExp(`NEEDED.*lib${library}\\.so`).test(dynamic),
      files.some((name) => expression.test(name)),
      `${library}: selected linkage`,
    );
  }
  for (const name of files.filter((file) => /^libfdk-aac\.so/.test(file))) {
    assert.doesNotMatch(
      run('readelf', ['-d', join(dirname(ffmpeg), name)]).toString(),
      /NEEDED.*libstdc\+\+/,
    );
    assert.doesNotMatch(
      run('nm', ['-D', '--defined-only', join(dirname(ffmpeg), name)]).toString(),
      /\b_Z\w+/,
    );
  }
  console.log('Selected specialized-library ELF dependencies and private C++ exports passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
