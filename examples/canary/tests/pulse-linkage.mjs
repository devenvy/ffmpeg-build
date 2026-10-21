import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const TIMEOUT = 30000;
const READY_ATTEMPTS = 120;
const READY_DELAY = 1000;
const CAPTURE_DELAY = 200;
const RATE = 48000;
const FLOAT_BYTES = 4;
const MIN_POWER = 0.0001;
const MAX_POWER = 0.1;
const SERVER =
  'mirror.gcr.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587';
const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg, 'The target test runner must set FFMPEG');
const name = `ffb-pulse-${process.pid}-${Date.now()}`;
const ownedServer = !process.env.PULSE_SERVER;
let prefix = [ffmpeg];
const command = (program, args) => {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout: TIMEOUT });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
const audio = (args) => {
  const child = spawn(
    prefix[0],
    [...prefix.slice(1), '-nostdin', '-hide_banner', '-loglevel', 'error', ...args],
    {
      env: process.env,
      timeout: TIMEOUT,
    },
  );
  const output = [];
  const errors = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => errors.push(chunk));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => {
      if (status !== 0) {
        reject(new Error(`PulseAudio FFmpeg exited ${status}: ${Buffer.concat(errors)}`));
      } else {
        resolve(Buffer.concat(output));
      }
    });
  });
  // A failed capture can finish while playback is being started; retain its rejection for Promise.all.
  done.catch(() => {
    // Promise.all below reports failures after both streams have been started.
  });
  return done;
};
try {
  if (ownedServer) {
    command('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--cpus',
      '2',
      '--mount',
      `type=bind,src=${dirname(ffmpeg)},dst=/ffmpeg,readonly`,
      SERVER,
      'bash',
      '-euc',
      'apt-get update -qq && apt-get install -y -qq --no-install-recommends pulseaudio pulseaudio-utils binutils >/dev/null && exec pulseaudio --system --daemonize=no --disallow-exit --exit-idle-time=-1 -n --load="module-null-sink sink_name=ffb rate=48000 channels=1" --load="module-native-protocol-tcp listen=127.0.0.1 port=4713 auth-anonymous=1"',
    ]);
    let ready = false;
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
      const probe = spawnSync(
        'docker',
        ['exec', name, 'pactl', '-s', 'tcp:127.0.0.1:4713', 'info'],
        {
          encoding: 'utf8',
          timeout: TIMEOUT,
        },
      );
      if (probe.status === 0) {
        ready = true;
        break;
      }
      await setTimeout(READY_DELAY);
    }
    assert.ok(ready, 'The isolated PulseAudio null sink must start');
    prefix = ['docker', 'exec', '-e', 'PULSE_SERVER=tcp:127.0.0.1:4713', name, '/ffmpeg/ffmpeg'];
  }
  const capture = audio([
    '-f',
    'pulse',
    '-sample_rate',
    String(RATE),
    '-channels',
    '1',
    '-fragment_size',
    '1920',
    '-i',
    'ffb.monitor',
    '-af',
    'asetpts=N/SR/TB',
    '-t',
    '1',
    '-f',
    'f32le',
    '-',
  ]);
  await setTimeout(CAPTURE_DELAY);
  const playback = audio([
    '-re',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=997:sample_rate=48000:duration=2',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    '-f',
    'pulse',
    '-buffer_duration',
    '50',
    '-prebuf',
    '0',
    'ffb',
  ]);
  const [samples] = await Promise.all([capture, playback]);
  assert.equal(samples.length, RATE * FLOAT_BYTES);
  let power = 0;
  for (let offset = 0; offset < samples.length; offset += FLOAT_BYTES) {
    const value = samples.readFloatLE(offset);
    assert.ok(Number.isFinite(value));
    power += value * value;
  }
  power /= RATE;
  assert.ok(power > MIN_POWER && power < MAX_POWER, `Pulse monitor signal power was ${power}`);
  const library = readdirSync(dirname(ffmpeg)).find((file) =>
    /^libavdevice\.so\.\d+\.\d+\.\d+$/.test(file),
  );
  assert.ok(library, 'The packaged FFmpeg device library must exist');
  const path = ownedServer ? `/ffmpeg/${library}` : join(dirname(ffmpeg), library);
  const elf = (args) =>
    ownedServer
      ? command('docker', ['exec', name, 'readelf', ...args, path])
      : command('readelf', [...args, path]);
  const shared = existsSync(join(dirname(ffmpeg), 'libpulse.so.0'));
  assert.equal(/NEEDED.*libpulse\.so/.test(elf(['-d'])), shared);
  const exported = elf(['--dyn-syms', '--wide'])
    .split('\n')
    .filter((line) => !/\bUND\b/.test(line));
  assert.ok(
    exported.every((line) => !/\b(?:pa_|jack_)\w+(?:@@\S+)?$/.test(line)),
    'Private audio-client symbols must not escape FFmpeg’s exported ABI',
  );
  console.log(
    `Pulse ${shared ? 'shared' : 'static'} playback/monitor capture passed, power=${power}`,
  );
} finally {
  if (ownedServer) {
    spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: TIMEOUT });
  }
}
