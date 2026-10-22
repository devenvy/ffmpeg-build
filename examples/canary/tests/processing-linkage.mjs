import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-processing-'));
const FLAGS = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
const TIMEOUT = 120000;
const MAX_OUTPUT = 4194304;
const WIDTH = 128;
const HEIGHT = 128;
const FRAMES = 12;
const FPS = 8;
const MAX_PIXEL_ERROR = 25;
const RATE = 48000;
const SAMPLE_BYTES = 4;
const SOURCE_SECONDS = 4;
const FREQUENCY = 997;
const TEMPO = 1.25;
const PITCH = 1.5;
const DURATION_TOLERANCE = 0.02;
const FREQUENCY_TOLERANCE = 10;
const MIN_POWER = 0.0001;
const MAX_POWER = 0.1;
const FINGERPRINT_RATE = 44100;
const FINGERPRINT_SECONDS = 24;
const FINGERPRINT_BYTES = 2;
const MIN_FINGERPRINT_BYTES = 64;
const AMPLITUDE = 5400;
const WINDOW_START = 0.25;
const WINDOW_END = 0.75;
const NOTE_SECONDS = 3;
const TWO_PI = Math.PI + Math.PI;
const BEAT_HZ = 2;
const ENVELOPE_FLOOR = 0.3;
const ENVELOPE_RANGE = 0.7;
const HALF = 0.5;
const THIRD_RATIO = 1.25;
const FIFTH_RATIO = 1.5;
const THIRD_WEIGHT = 0.5;
const FIFTH_WEIGHT = 0.25;
const FIRST_NOTES = { a3: 220, cs4: 277.18, e4: 329.63, b3: 246.94 };
const SECOND_NOTES = { g3: 196, c4: 261.63, f4: 349.23, a4: 440 };
const run = (program, args, input) => {
  const result = spawnSync(program, args, { input, timeout: TIMEOUT, maxBuffer: MAX_OUTPUT });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr?.toString());
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
  const encoded = join(work, 'authored.evc');
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
      'libxeve',
      '-preset',
      'fast',
      '-qp',
      '28',
      '-bf',
      '3',
      '-g',
      '8',
      '-threads',
      '2',
      '-f',
      'evc',
      encoded,
    ],
    source,
  );
  const decoded = ff([
    '-c:v',
    'evc',
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
  assert.equal(decoded.length, source.length, 'EVC must drain every authored frame through EOF');
  let difference = 0;
  for (let offset = 0; offset < source.length; offset++) {
    difference += Math.abs(decoded[offset] - source[offset]);
  }
  assert.ok(difference / source.length < MAX_PIXEL_ERROR);
  console.log(`XEVE/XEVD: all ${FRAMES} delayed frames and authored pixels passed`);

  const audio = ff([
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${FREQUENCY}:sample_rate=${RATE}:duration=${SOURCE_SECONDS}`,
    '-af',
    `rubberband=tempo=${TEMPO}:pitch=${PITCH}`,
    '-f',
    'f32le',
    '-',
  ]);
  assert.equal(audio.length % SAMPLE_BYTES, 0);
  const samples = audio.length / SAMPLE_BYTES;
  const expectedSamples = (SOURCE_SECONDS * RATE) / TEMPO;
  assert.ok(
    Math.abs(samples - expectedSamples) / expectedSamples < DURATION_TOLERANCE,
    `Rubber Band output duration: ${samples / RATE}`,
  );
  let power = 0;
  for (let offset = 0; offset < audio.length; offset += SAMPLE_BYTES) {
    const sample = audio.readFloatLE(offset);
    assert.ok(Number.isFinite(sample));
    power += sample * sample;
  }
  power /= samples;
  assert.ok(power > MIN_POWER && power < MAX_POWER);
  const start = Math.floor(samples * WINDOW_START);
  const end = Math.floor(samples * WINDOW_END);
  let crossings = 0;
  for (let sample = start + 1; sample < end; sample++) {
    if (
      audio.readFloatLE((sample - 1) * SAMPLE_BYTES) <= 0 &&
      audio.readFloatLE(sample * SAMPLE_BYTES) > 0
    ) {
      crossings++;
    }
  }
  const frequency = (crossings * RATE) / (end - start);
  assert.ok(
    Math.abs(frequency - FREQUENCY * PITCH) < FREQUENCY_TOLERANCE,
    `Rubber Band pitch: ${frequency}`,
  );
  console.log('Rubber Band: complete output duration, pitch and finite nonsilent audio passed');

  const authored = (notes) => {
    const pcm = Buffer.alloc(FINGERPRINT_RATE * FINGERPRINT_SECONDS * FINGERPRINT_BYTES);
    for (let sample = 0; sample < pcm.length / FINGERPRINT_BYTES; sample++) {
      const time = sample / FINGERPRINT_RATE;
      const base = notes[Math.floor(time / NOTE_SECONDS) % notes.length];
      const phase = TWO_PI * base * time;
      const envelope =
        ENVELOPE_FLOOR + ENVELOPE_RANGE * (HALF + HALF * Math.sin(TWO_PI * BEAT_HZ * time));
      pcm.writeInt16LE(
        Math.round(
          AMPLITUDE *
            envelope *
            (Math.sin(phase) +
              THIRD_WEIGHT * Math.sin(phase * THIRD_RATIO) +
              FIFTH_WEIGHT * Math.sin(phase * FIFTH_RATIO)),
        ),
        sample * FINGERPRINT_BYTES,
      );
    }
    return pcm;
  };
  const fingerprint = (pcm) =>
    ff(
      [
        '-f',
        's16le',
        '-ar',
        String(FINGERPRINT_RATE),
        '-ac',
        '1',
        '-i',
        '-',
        '-c:a',
        'pcm_s16le',
        '-f',
        'chromaprint',
        '-fp_format',
        'raw',
        '-',
      ],
      pcm,
    );
  const first = authored(Object.values(FIRST_NOTES));
  const printed = fingerprint(first);
  assert.ok(printed.length > MIN_FINGERPRINT_BYTES);
  assert.equal(printed.length % SAMPLE_BYTES, 0);
  assert.deepEqual(
    printed,
    fingerprint(first),
    'Identical authored audio must fingerprint consistently',
  );
  assert.notDeepEqual(
    printed,
    fingerprint(authored(Object.values(SECOND_NOTES))),
    'Different harmony must change the fingerprint',
  );
  console.log(
    `Chromaprint authored harmony/repeatability passed: ${createHash('sha256').update(printed).digest('hex')}`,
  );

  const files = readdirSync(dirname(ffmpeg));
  const dynamic = files
    .filter((name) => /\.so(?:\.|$)/.test(name))
    .map((name) => run('readelf', ['-d', join(dirname(ffmpeg), name)]).toString())
    .join('\n');
  for (const name of ['rubberband', 'chromaprint', 'xeve', 'xevd']) {
    const bundled = files.some((file) => new RegExp(`^lib${name}\\.so`).test(file));
    assert.equal(
      new RegExp(`NEEDED.*lib${name}\\.so`).test(dynamic),
      bundled,
      `${name}: selected linkage`,
    );
  }
  for (const name of files.filter((file) =>
    /^lib(rubberband|chromaprint)\.so(?:\.|$)/.test(file),
  )) {
    const file = join(dirname(ffmpeg), name);
    assert.doesNotMatch(run('readelf', ['-d', file]).toString(), /NEEDED.*libstdc\+\+/);
    assert.doesNotMatch(
      run('nm', ['-D', '--defined-only', file]).toString(),
      /\b(?:_Z(?:St|N[KVO]?St|T[ISV]St)|__cxa_|_Unwind_)\w+/,
    );
  }
  console.log('Selected processing/EVC ELF dependencies and private compiler exports passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
