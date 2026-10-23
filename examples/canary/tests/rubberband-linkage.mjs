import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const rate = 48000;
const seconds = 4;
const tempo = 1.25;
const durationTolerance = 0.02;
const minimumPower = 0.0001;
const maximumPower = 0.1;
const result = spawnSync(
  ffmpeg,
  [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=997:sample_rate=${rate}:duration=${seconds}`,
    '-af',
    `rubberband=tempo=${tempo}:pitch=1.5`,
    '-f',
    'f32le',
    '-',
  ],
  { timeout: 60000, maxBuffer: 4194304 },
);
assert.equal(result.status, 0, result.error?.message ?? result.stderr?.toString());
const sampleBytes = 4;
assert.equal(result.stdout.length % sampleBytes, 0);
const samples = result.stdout.length / sampleBytes;
const expected = (rate * seconds) / tempo;
assert.ok(
  Math.abs(samples - expected) / expected < durationTolerance,
  `Unexpected sample count ${samples}`,
);
let energy = 0;
for (let offset = 0; offset < result.stdout.length; offset += sampleBytes) {
  const sample = result.stdout.readFloatLE(offset);
  assert.ok(Number.isFinite(sample));
  energy += sample * sample;
}
const power = energy / samples;
assert.ok(power > minimumPower && power < maximumPower, `Unexpected signal power ${power}`);
console.log('Rubber Band: natural EOF, changed duration and finite nonsilent audio passed');
