import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-audio-devices-'));
const RATE = 48000;
const CHANNEL_BYTES = 2;
const EXPECTED_BYTES = 9600;
const PATTERN_MODULUS = 251;
const PATTERN_MULTIPLIER = 17;
const PATTERN_OFFSET = 31;
const TIMEOUT = 30000;
const MAX_OUTPUT = 8388608;
const pattern = Buffer.from(
  Array.from(
    { length: RATE * CHANNEL_BYTES * CHANNEL_BYTES },
    (_, index) => (index * PATTERN_MULTIPLIER + PATTERN_OFFSET) % PATTERN_MODULUS,
  ),
);
const environment = {
  ...process.env,
  LD_BIND_NOW: '1',
  ALSA_CONFIG_PATH: join(work, 'asound.conf'),
  ALSOFT_CONF: join(work, 'alsoft.conf'),
  ALSOFT_DRIVERS: 'alsa',
};
const execute = (program, args) =>
  spawnSync(program, args, {
    env: environment,
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
const run = (args) => {
  const result = execute(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args]);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
};
const reject = (args) => {
  const result = execute(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args]);
  assert.equal(result.error, undefined);
  assert.ok(result.status !== 0 && result.status !== null);
};
const config = `
pcm.ffb_capture {
  type file
  slave.pcm { type null }
  file "/dev/null"
  infile "${work}/capture.raw"
  format "raw"
}
pcm.ffb_playback {
  type file
  slave.pcm { type null }
  file "${work}/openal-playback.raw"
  format "raw"
}
pcm.hw {
  @args [ CARD DEV SUBDEV ]
  @args.CARD { type string default "0" }
  @args.DEV { type integer default 0 }
  @args.SUBDEV { type integer default -1 }
  type file
  slave.pcm { type null }
  file "${work}/sndio-playback.raw"
  infile "${work}/capture.raw"
  format "raw"
}
`;
try {
  writeFileSync(join(work, 'capture.raw'), pattern);
  writeFileSync(environment.ALSA_CONFIG_PATH, config);
  writeFileSync(environment.ALSOFT_CONF, '[alsa]\ncapture = ffb_capture\ndevice = ffb_playback\n');
  const devices = execute(ffmpeg, ['-hide_banner', '-devices']);
  assert.equal(devices.status, 0);
  const listing = devices.stdout.toString() + devices.stderr.toString();
  assert.match(listing, /openal/);
  assert.match(listing, /sndio/);
  for (const [device, input] of [
    ['openal', ''],
    ['sndio', 'rsnd/0'],
  ]) {
    const output = run([
      '-f',
      device,
      '-channels',
      '1',
      '-sample_rate',
      String(RATE),
      '-i',
      input,
      '-af',
      'atrim=end_sample=4800,asetpts=N/SR/TB',
      '-t',
      '0.1',
      '-c:a',
      'pcm_s16le',
      '-f',
      's16le',
      'pipe:1',
    ]);
    assert.equal(output.length, EXPECTED_BYTES, `${device}: sample count`);
    assert.deepEqual(output, pattern.subarray(0, EXPECTED_BYTES));
  }
  run([
    '-f',
    's16le',
    '-ar',
    String(RATE),
    '-ac',
    '1',
    '-i',
    join(work, 'capture.raw'),
    '-t',
    '0.1',
    '-f',
    'sndio',
    'rsnd/0',
  ]);
  const playback = readFileSync(join(work, 'sndio-playback.raw'));
  assert.equal(playback.length, EXPECTED_BYTES);
  assert.deepEqual(playback, pattern.subarray(0, EXPECTED_BYTES));
  reject(['-f', 'openal', '-i', 'ffb-missing-device', '-t', '0.1', '-f', 'null', '-']);
  reject(['-f', 'sndio', '-i', 'rsnd/0,invalid', '-t', '0.1', '-f', 'null', '-']);
  for (const [name, soname, privatePrefix] of [
    ['libopenal.so', 'libopenal.so.1', /\b(?:snd_|_Z)/],
    ['libsndio.so', 'libsndio.so.7', /\b(?:snd_|strl)/],
  ]) {
    const file = join(dirname(ffmpeg), name);
    if (existsSync(file)) {
      const dynamic = execute('readelf', ['-d', file]);
      assert.equal(dynamic.status, 0);
      assert.ok(dynamic.stdout.toString().includes(`[${soname}]`));
      assert.doesNotMatch(dynamic.stdout.toString(), /libstdc\+\+\.so/);
      const symbols = execute('nm', ['-D', '--defined-only', file]);
      assert.equal(symbols.status, 0);
      assert.doesNotMatch(symbols.stdout.toString(), privatePrefix);
    }
  }
  console.log(
    'Audio devices: exact4800sample OpenAL/sndio software capture and sndio playback, missing PCM/device rejection and private native ELF closure passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
