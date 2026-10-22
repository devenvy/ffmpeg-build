import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-media-'));
const TIMEOUT = 120000;
const MAX_OUTPUT = 8388608;
const FLOAT_BYTES = 4;
const PCM_BYTES = 2;
const RATE = 8000;
const TONE_HZ = 220;
const AMPLITUDE = 6000;
const TWO_PI = Math.PI + Math.PI;
const MIN_POWER = 0.00001;
const GSM_FRAMES = 50;
const GSM_FRAME_BYTES = 33;
const MS_BLOCKS = 25;
const MS_BLOCK_BYTES = 65;
const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const WORD_BYTES = 4;
const VGM_HEADER_BYTES = 64;
const VGM_VERSION_OFFSET = 8;
const VGM_CLOCK_OFFSET = 12;
const VGM_SAMPLES_OFFSET = 24;
const VGM_DATA_OFFSET = 52;
const VGM_DATA_RELATIVE = 12;
const VGM_VERSION = 0x150;
const VGM_CLOCK = 3579545;
const VGM_SAMPLES = 48510;
const VGM_RATE = 44100;
const VGM_MIN_SECONDS = 1.05;
const VGM_MAX_SECONDS = 1.25;
const VGM_TONE_START = 0.2;
const VGM_TONE_END = 0.8;
const VGM_HZ = 440;
const FREQUENCY_ERROR = 8;
const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_OVERHEAD = 12;
const ICC_MIN_BYTES = 128;
const ICC_COLOR_OFFSET = 16;
const ICC_MAGIC_OFFSET = 36;
const ICC_FIELD_BYTES = 4;
const TEXT_RATE = 16000;
const TEXT_MIN_SECONDS = 0.5;
const TEXT_MAX_SECONDS = 12;
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
const waveDataBytes = (bytes) => {
  for (let offset = RIFF_HEADER_BYTES; offset + CHUNK_HEADER_BYTES <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + WORD_BYTES);
    if (bytes.toString('ascii', offset, offset + WORD_BYTES) === 'data') {
      return size;
    }
    offset += CHUNK_HEADER_BYTES + size + (size % PCM_BYTES);
  }
  throw new Error('WAV must contain a data chunk');
};
const audio = (bytes) => {
  assert.equal(bytes.length % FLOAT_BYTES, 0);
  let energy = 0;
  for (let offset = 0; offset < bytes.length; offset += FLOAT_BYTES) {
    const sample = bytes.readFloatLE(offset);
    assert.ok(Number.isFinite(sample));
    energy += sample * sample;
  }
  assert.ok(energy / (bytes.length / FLOAT_BYTES) > MIN_POWER);
  return bytes.length / FLOAT_BYTES;
};
try {
  const speech = Buffer.alloc(RATE * PCM_BYTES);
  for (let sample = 0; sample < RATE; sample++) {
    speech.writeInt16LE(
      Math.round(AMPLITUDE * Math.sin((TWO_PI * TONE_HZ * sample) / RATE)),
      sample * PCM_BYTES,
    );
  }
  for (const [codec, format, extension] of [
    ['libgsm', 'gsm', 'gsm'],
    ['libgsm_ms', 'wav', 'wav'],
  ]) {
    const file = join(work, `authored.${extension}`);
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
        codec,
        '-f',
        format,
        file,
      ],
      speech,
    );
    const bytes = run('cat', [file]);
    if (format === 'gsm') {
      assert.equal(bytes.length, GSM_FRAMES * GSM_FRAME_BYTES);
    } else {
      assert.equal(waveDataBytes(bytes), MS_BLOCKS * MS_BLOCK_BYTES);
    }
    const decoded = ff(['-c:a', codec, '-i', file, '-f', 'f32le', '-'], undefined);
    assert.equal(audio(decoded), RATE, `${codec}: complete natural EOF`);
  }
  console.log('GSM and WAV49 authored encode/decode and exact natural EOF passed');

  // SN76489: mute channels 1/2/noise, tone 0 divider 254 at full volume,
  // wait 44100 samples, mute, wait 4410 samples, end. No loop or external assets.
  const commands = Buffer.from('50bf50df50ff508e500f50906144ac509f613a1166', 'hex');
  const header = Buffer.alloc(VGM_HEADER_BYTES);
  header.write('Vgm ');
  header.writeUInt32LE(header.length + commands.length - WORD_BYTES, WORD_BYTES);
  header.writeUInt32LE(VGM_VERSION, VGM_VERSION_OFFSET);
  header.writeUInt32LE(VGM_CLOCK, VGM_CLOCK_OFFSET);
  header.writeUInt32LE(VGM_SAMPLES, VGM_SAMPLES_OFFSET);
  header.writeUInt32LE(VGM_DATA_RELATIVE, VGM_DATA_OFFSET);
  const vgm = join(work, 'authored.vgm');
  writeFileSync(vgm, Buffer.concat([header, commands]));
  const game = ff([
    '-f',
    'libgme',
    '-i',
    vgm,
    '-ac',
    '1',
    '-ar',
    String(VGM_RATE),
    '-f',
    'f32le',
    '-',
  ]);
  const gameSamples = audio(game);
  const gameSeconds = gameSamples / VGM_RATE;
  assert.ok(
    gameSeconds >= VGM_MIN_SECONDS && gameSeconds <= VGM_MAX_SECONDS,
    `Finite VGM EOF: ${gameSeconds}`,
  );
  let crossings = 0;
  let previous = 0;
  for (
    let sample = Math.floor(VGM_TONE_START * VGM_RATE);
    sample < VGM_TONE_END * VGM_RATE;
    sample++
  ) {
    const value = game.readFloatLE(sample * FLOAT_BYTES);
    if (previous <= 0 && value > 0) {
      crossings++;
    }
    previous = value;
  }
  const hz = crossings / (VGM_TONE_END - VGM_TONE_START);
  assert.ok(Math.abs(hz - VGM_HZ) < FREQUENCY_ERROR, `VGM tone frequency: ${hz}`);
  console.log(`Authored finite VGM tone/EOF passed: ${gameSamples} samples, ${hz}Hz`);

  const png = ff([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=32x32:rate=1',
    '-vf',
    'format=rgb24,iccgen=color_primaries=bt2020:color_trc=linear',
    '-frames:v',
    '1',
    '-c:v',
    'png',
    '-f',
    'image2pipe',
    '-',
  ]);
  let profile;
  for (let offset = PNG_SIGNATURE_BYTES; offset + PNG_CHUNK_OVERHEAD <= png.length;) {
    const size = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + WORD_BYTES, offset + CHUNK_HEADER_BYTES);
    if (type === 'iCCP') {
      const chunk = png.subarray(offset + CHUNK_HEADER_BYTES, offset + CHUNK_HEADER_BYTES + size);
      const nameEnd = chunk.indexOf(0);
      assert.ok(nameEnd > 0);
      assert.equal(chunk[nameEnd + 1], 0);
      profile = inflateSync(chunk.subarray(nameEnd + PCM_BYTES));
    }
    offset += PNG_CHUNK_OVERHEAD + size;
  }
  assert.ok(
    profile && profile.length >= ICC_MIN_BYTES,
    'PNG must carry a real generated ICC profile',
  );
  assert.equal(profile.readUInt32BE(0), profile.length);
  assert.equal(
    profile.toString('ascii', ICC_COLOR_OFFSET, ICC_COLOR_OFFSET + ICC_FIELD_BYTES),
    'RGB ',
  );
  assert.equal(
    profile.toString('ascii', ICC_MAGIC_OFFSET, ICC_MAGIC_OFFSET + ICC_FIELD_BYTES),
    'acsp',
  );
  const detected = spawnSync(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'info',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      '-i',
      '-',
      '-vf',
      'setparams=color_primaries=bt709:color_trc=bt709,iccdetect=force=1,showinfo',
      '-f',
      'null',
      '-',
    ],
    { input: png, timeout: TIMEOUT, maxBuffer: MAX_OUTPUT },
  );
  assert.equal(detected.status, 0, detected.stderr.toString());
  assert.match(detected.stderr.toString(), /color_primaries:bt2020.*color_trc:linear/);
  console.log('Little CMS generated PNG ICC payload and forced profile-based tag detection passed');

  for (const voice of ['awb', 'kal', 'kal16', 'rms', 'slt']) {
    const synthesized = ff([
      '-f',
      'lavfi',
      '-i',
      `flite=text='A small bright bird sings beside the river':voice=${voice}`,
      '-ar',
      String(TEXT_RATE),
      '-ac',
      '1',
      '-f',
      'f32le',
      '-',
    ]);
    const seconds = audio(synthesized) / TEXT_RATE;
    assert.ok(
      seconds >= TEXT_MIN_SECONDS && seconds <= TEXT_MAX_SECONDS,
      `${voice}: finite complete speech ${seconds}`,
    );
  }
  const invalid = spawnSync(
    ffmpeg,
    [
      ...FLAGS,
      '-f',
      'lavfi',
      '-i',
      'flite=text=hello:voice=ffb_nonexistent_voice',
      '-f',
      'null',
      '-',
    ],
    { timeout: TIMEOUT },
  );
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.signal, null);
  assert.match(invalid.stderr.toString(), /voice|Invalid argument/i);
  console.log('All five Flite voices, complete finite speech, and unknown-voice rejection passed');

  const files = readdirSync(dirname(ffmpeg));
  const dynamic = files
    .filter((name) => /\.so(?:\.|$)/.test(name))
    .map((name) => run('readelf', ['-d', join(dirname(ffmpeg), name)]).toString())
    .join('\n');
  for (const name of ['lcms2', 'gsm', 'gme', 'flite']) {
    const bundled = files.some((file) => new RegExp(`^lib${name}\\.so`).test(file));
    assert.equal(
      new RegExp(`NEEDED.*lib${name}\\.so`).test(dynamic),
      bundled,
      `${name}: selected linkage`,
    );
  }
  for (const name of files.filter((file) => /^libgme\.so(?:\.|$)/.test(file))) {
    const file = join(dirname(ffmpeg), name);
    assert.doesNotMatch(run('readelf', ['-d', file]).toString(), /NEEDED.*libstdc\+\+/);
    assert.doesNotMatch(
      run('nm', ['-D', '--defined-only', file]).toString(),
      /\b(?:_Z(?:St|N[KVO]?St|T[ISV]St)|__cxa_|_Unwind_)\w+/,
    );
  }
  if (files.some((file) => /^libflite\.so/.test(file))) {
    for (const voice of [
      'usenglish',
      'cmulex',
      'cmu_time_awb',
      'cmu_us_awb',
      'cmu_us_kal',
      'cmu_us_kal16',
      'cmu_us_rms',
      'cmu_us_slt',
    ]) {
      assert.ok(
        files.some((file) => file.startsWith(`libflite_${voice}.so`)),
        `Flite native closure: ${voice}`,
      );
    }
  }
  console.log('Selected media-library ELF dependencies and private compiler exports passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
