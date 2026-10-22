import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const ffprobe = join(dirname(ffmpeg), 'ffprobe');
const fixtures = dirname(fileURLToPath(import.meta.url));
const TIMEOUT = 60000;
const MAX_OUTPUT = 67108864;
const VIDEO_PACKETS = 4500;
const AUDIO_PACKETS = 5625;
const FRAME_COUNT = 75;
const WIDTH = 8;
const CHANNELS = 3;
const BLUE_CHANNEL = 2;
const AUDIO_SAMPLES = 48000;
const SAMPLE_BYTES = 4;
const FREQUENCY = 750;
const BLUE_MINIMUM = 240;
const OTHER_MAXIMUM = 5;
const MINIMUM_RMS = 0.08;
const MAXIMUM_RMS = 0.1;
const FREQUENCY_TOLERANCE = 2;
const CROSSING_THRESHOLD = 0.03;
const MINIMUM_ACTIVE_FRACTION = 0.98;
const INVALID_PLAYLIST = 99999;
const work = mkdtempSync(join(tmpdir(), 'ffb-bluray-'));
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
const argumentsFor = (path) => ['-hide_banner', '-v', 'error', '-i', `bluray:${path}`];
try {
  const manifest = JSON.parse(readFileSync(join(fixtures, 'bluray-fixture.json'), 'utf8'));
  const contents = command(
    'xz',
    ['--decompress', '--stdout'],
    Buffer.from(readFileSync(join(fixtures, 'bluray.base64'), 'utf8').trim(), 'base64'),
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
  for (const path of [join(work, 'disc'), join(work, 'owned.iso')]) {
    const metadata = JSON.parse(
      command(ffprobe, [
        ...argumentsFor(path),
        '-count_packets',
        '-show_streams',
        '-of',
        'json',
      ]).toString(),
    );
    const video = metadata.streams.find((stream) => stream.codec_type === 'video');
    const sound = metadata.streams.find((stream) => stream.codec_type === 'audio');
    assert.equal(video.codec_name, 'mpeg2video');
    assert.equal(sound.codec_name, 'ac3');
    assert.equal(Number(video.nb_read_packets), VIDEO_PACKETS);
    assert.equal(Number(sound.nb_read_packets), AUDIO_PACKETS);
    const pixels = command(ffmpeg, [
      ...argumentsFor(path),
      '-map',
      '0:v:0',
      '-frames:v',
      String(FRAME_COUNT),
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
        pixels[offset] <= OTHER_MAXIMUM &&
          pixels[offset + 1] <= OTHER_MAXIMUM &&
          pixels[offset + BLUE_CHANNEL] >= BLUE_MINIMUM,
      );
    }
    const audio = command(ffmpeg, [
      ...argumentsFor(path),
      '-map',
      '0:a:0',
      '-t',
      '1',
      '-f',
      'f32le',
      '-',
    ]);
    assert.equal(audio.length, AUDIO_SAMPLES * SAMPLE_BYTES);
    let energy = 0;
    let crossings = 0;
    let firstCrossing = -1;
    let lastCrossing = -1;
    let negative = false;
    for (let offset = 0; offset < audio.length; offset += SAMPLE_BYTES) {
      const value = audio.readFloatLE(offset);
      assert.ok(Number.isFinite(value));
      energy += value * value;
      if (value < -CROSSING_THRESHOLD) {
        negative = true;
      }
      if (negative && value > CROSSING_THRESHOLD) {
        firstCrossing = firstCrossing < 0 ? offset / SAMPLE_BYTES : firstCrossing;
        lastCrossing = offset / SAMPLE_BYTES;
        crossings++;
        negative = false;
      }
    }
    const rms = Math.sqrt(energy / AUDIO_SAMPLES);
    assert.ok(rms > MINIMUM_RMS && rms < MAXIMUM_RMS, `RMS ${rms}`);
    // AC-3 encoder priming can delay the first cycle; measure periods after it starts.
    assert.ok(crossings > FREQUENCY * MINIMUM_ACTIVE_FRACTION);
    const measured = ((crossings - 1) * AUDIO_SAMPLES) / (lastCrossing - firstCrossing);
    assert.ok(Math.abs(measured - FREQUENCY) < FREQUENCY_TOLERANCE, `Frequency ${measured}`);
    if (firstAudio) {
      assert.deepEqual(audio, firstAudio);
    }
    firstAudio = audio;
  }
  for (const input of [
    [...argumentsFor(join(work, 'missing.iso')), '-f', 'null', '-'],
    [
      '-hide_banner',
      '-v',
      'error',
      '-playlist',
      String(INVALID_PLAYLIST),
      '-i',
      `bluray:${join(work, 'owned.iso')}`,
      '-f',
      'null',
      '-',
    ],
  ]) {
    const rejected = spawnSync(ffmpeg, input, {
      env: environment,
      timeout: TIMEOUT,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_OUTPUT,
    });
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.signal, null);
    assert.match(rejected.stderr.toString(), /open|error|invalid|failed/iu);
  }
  const installed = readdirSync(dirname(ffmpeg));
  for (const name of ['libbluray.so.4', 'libudfread.so.3'].filter((candidate) =>
    installed.includes(candidate),
  )) {
    const library = join(dirname(ffmpeg), name);
    const dynamic = command('readelf', ['-d', library]).toString();
    assert.ok(dynamic.includes(`[${name}]`));
    assert.doesNotMatch(dynamic, /libstdc\+\+\.so/u);
    const exports = command('nm', ['-D', '--defined-only', library]).toString();
    assert.doesNotMatch(exports, /\b(?:xml|inflate|deflate|adler32|crc32)\w+/u);
    if (name.startsWith('libbluray')) {
      assert.doesNotMatch(exports, /\budfread_\w+/u);
    }
  }
  console.log(
    'Blu-ray: owned folder/ISO, full180second packet counts to EOF, 75 decoded blue frames and 1second750Hz audio, missing image/playlist and private ELF closure passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
