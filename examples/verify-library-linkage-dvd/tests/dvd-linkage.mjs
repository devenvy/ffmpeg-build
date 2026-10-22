import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const ffprobe = join(dirname(ffmpeg), 'ffprobe');
const fixtures = dirname(fileURLToPath(import.meta.url));
const TIMEOUT = 60000;
const MAX_OUTPUT = 8388608;
const FRAME_COUNT = 75;
const WIDTH = 8;
const CHANNELS = 3;
const AUDIO_SAMPLES = 141312;
const SAMPLE_BYTES = 4;
const SAMPLE_RATE = 48000;
const FREQUENCY = 1000;
const RED_MINIMUM = 240;
const OTHER_MAXIMUM = 5;
const MINIMUM_RMS = 0.08;
const MAXIMUM_RMS = 0.1;
const FREQUENCY_TOLERANCE = 2;
const CROSSING_THRESHOLD = 0.03;
const SECOND_CHAPTER = 1.2;
const THIRD_CHAPTER = 1.8;
const DURATION = 3;
const BLUE_CHANNEL = 2;
const CHAPTER_TIMES = [
  [0, SECOND_CHAPTER],
  [SECOND_CHAPTER, THIRD_CHAPTER],
  [THIRD_CHAPTER, DURATION],
];
const work = mkdtempSync(join(tmpdir(), 'ffb-dvd-'));
const environment = { ...process.env, LD_BIND_NOW: '1' };
const command = (program, args, input) => {
  const result = spawnSync(program, args, {
    input,
    env: environment,
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
  assert.equal(
    result.status,
    0,
    `${program}: ${result.error?.message ?? result.stderr?.toString()}`,
  );
  assert.equal(result.signal, null);
  return result.stdout;
};
const argumentsFor = (path) => [
  '-hide_banner',
  '-v',
  'error',
  '-f',
  'dvdvideo',
  '-title',
  '1',
  '-i',
  path,
];
try {
  const manifest = JSON.parse(readFileSync(join(fixtures, 'dvd-fixture.json'), 'utf8'));
  const contents = gunzipSync(
    Buffer.from(readFileSync(join(fixtures, 'dvd.base64'), 'utf8').trim(), 'base64'),
  );
  assert.equal(createHash('sha256').update(contents).digest('hex'), manifest.tarSha256);
  command('tar', ['-xf', '-', '-C', work], contents);
  for (const [name, hash] of Object.entries(manifest.files)) {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(join(work, name)))
        .digest('hex'),
      hash,
    );
  }
  let firstAudio;
  for (const path of [join(work, 'dvd'), join(work, 'owned.iso')]) {
    const metadata = JSON.parse(
      command(ffprobe, [
        ...argumentsFor(path),
        '-show_streams',
        '-show_chapters',
        '-of',
        'json',
      ]).toString(),
    );
    assert.equal(
      metadata.streams.find((stream) => stream.codec_type === 'video').codec_name,
      'mpeg2video',
    );
    assert.equal(
      metadata.streams.find((stream) => stream.codec_type === 'audio').codec_name,
      'ac3',
    );
    assert.deepEqual(
      metadata.chapters.map((chapter) => [Number(chapter.start_time), Number(chapter.end_time)]),
      CHAPTER_TIMES,
    );
    const pixels = command(ffmpeg, [
      ...argumentsFor(path),
      '-map',
      '0:v:0',
      '-vf',
      `scale=${WIDTH}:${WIDTH}`,
      '-pix_fmt',
      'rgb24',
      '-fps_mode',
      'passthrough',
      '-f',
      'rawvideo',
      '-',
    ]);
    assert.equal(pixels.length, FRAME_COUNT * WIDTH * WIDTH * CHANNELS);
    for (let offset = 0; offset < pixels.length; offset += CHANNELS) {
      assert.ok(
        pixels[offset] >= RED_MINIMUM &&
          pixels[offset + 1] <= OTHER_MAXIMUM &&
          pixels[offset + BLUE_CHANNEL] <= OTHER_MAXIMUM,
      );
    }
    const audio = command(ffmpeg, [...argumentsFor(path), '-map', '0:a:0', '-f', 'f32le', '-']);
    assert.equal(audio.length, AUDIO_SAMPLES * SAMPLE_BYTES);
    let energy = 0;
    let crossings = 0;
    let negative = false;
    for (let offset = 0; offset < audio.length; offset += SAMPLE_BYTES) {
      const value = audio.readFloatLE(offset);
      assert.ok(Number.isFinite(value));
      energy += value * value;
      if (value < -CROSSING_THRESHOLD) {
        negative = true;
      }
      if (negative && value > CROSSING_THRESHOLD) {
        crossings++;
        negative = false;
      }
    }
    const rms = Math.sqrt(energy / AUDIO_SAMPLES);
    assert.ok(rms > MINIMUM_RMS && rms < MAXIMUM_RMS, `RMS ${rms}`);
    assert.ok(
      Math.abs((crossings * SAMPLE_RATE) / AUDIO_SAMPLES - FREQUENCY) < FREQUENCY_TOLERANCE,
      `Frequency ${(crossings * SAMPLE_RATE) / AUDIO_SAMPLES}, crossings ${crossings}, RMS ${rms}`,
    );
    if (firstAudio) {
      assert.deepEqual(audio, firstAudio);
    }
    firstAudio = audio;
  }
  const missing = spawnSync(
    ffmpeg,
    [...argumentsFor(join(work, 'missing.iso')), '-f', 'null', '-'],
    {
      env: environment,
      timeout: TIMEOUT,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_OUTPUT,
    },
  );
  assert.notEqual(missing.status, 0);
  assert.equal(missing.signal, null);
  assert.match(missing.stderr.toString(), /open|error|invalid/iu);
  const installed = readdirSync(dirname(ffmpeg));
  for (const name of ['libdvdread.so.8', 'libdvdnav.so.4'].filter((candidate) =>
    installed.includes(candidate),
  )) {
    const dynamic = command('readelf', ['-d', join(dirname(ffmpeg), name)]).toString();
    assert.ok(dynamic.includes(`[${name}]`));
    assert.doesNotMatch(dynamic, /libstdc\+\+\.so/u);
  }
  console.log(
    'DVD: owned folder/ISO, three chapter boundaries, 75 red frames, exact audio length and sine properties, natural EOF and missing image passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
