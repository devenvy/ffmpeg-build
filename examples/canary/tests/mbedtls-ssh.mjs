import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const FLAGS = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
const RATE = 16000;
const SAMPLE_BYTES = 4;
const MIN_POWER = 0.001;
const MAX_POWER = 0.02;
const run = (args) => {
  const result = spawnSync(ffmpeg, [...FLAGS, ...args], { timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr?.toString());
  return result.stdout;
};
const url = 'sftp://ffb:ffb-test-only@127.0.0.1:2222/home/ffb/authored.wav';
run([
  '-f',
  'lavfi',
  '-i',
  `sine=frequency=997:sample_rate=${RATE}:duration=1`,
  '-c:a',
  'pcm_s16le',
  '-f',
  'wav',
  url,
]);
const audio = run(['-i', url, '-f', 'f32le', '-']);
assert.equal(audio.length, RATE * SAMPLE_BYTES);
let power = 0;
for (let offset = 0; offset < audio.length; offset += SAMPLE_BYTES) {
  const sample = audio.readFloatLE(offset);
  assert.ok(Number.isFinite(sample));
  power += sample * sample;
}
power /= RATE;
assert.ok(power > MIN_POWER && power < MAX_POWER);
const rejected = spawnSync(
  ffmpeg,
  [...FLAGS, '-i', url.replace('ffb-test-only', 'incorrect-test-password'), '-f', 'null', '-'],
  { timeout: 15000 },
);
assert.equal(rejected.error, undefined);
assert.notEqual(rejected.status, 0, 'Incorrect SSH credentials must fail');
console.log(
  'libssh with shared threaded mbedTLS: SFTP audio and incorrect-password rejection passed',
);
