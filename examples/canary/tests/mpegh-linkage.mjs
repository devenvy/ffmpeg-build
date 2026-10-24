import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
const sample = process.env.MPEGH_SAMPLE;
assert.ok(ffmpeg && sample);
const SAMPLE_BYTES = 6733386;
const PCM_BYTES = 11520000;
const SAMPLE_SHA = '7aa464235b1015d3fa77eb5d34b70da6d6b68c07a1cd475a7d3859ed1f46f2af';
const PCM_SHA = '8de11b2344349e82230abb69b80b620585cbfe076c235ac72210e522d2f83583';
const TIMEOUT = 120000;
const MAX_OUTPUT = 33554432;
const RATE = 48000;
const CHANNELS = 2;
const SAMPLE_SIZE = 4;
const LEFT_FREQUENCY = 1000;
const RIGHT_FREQUENCY = 1800;
const FREQUENCIES = [LEFT_FREQUENCY, RIGHT_FREQUENCY];
const HALF_TURNS = 2;
const TAU = HALF_TURNS * Math.PI;
const REFERENCE_FREQUENCY = 3500;
const MIN_FRAMES = 12000;
const MAX_FRAMES = 15000;
const ENERGY_RATIO = 20;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixture = readFileSync(sample);
assert.equal(fixture.length, SAMPLE_BYTES);
assert.equal(hash(fixture), SAMPLE_SHA);
const execute = (args, input) => {
  const result = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
    env: { ...process.env, LD_BIND_NOW: '1' },
    input,
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
  return result.stdout;
};
const decoded = execute([
  '-ch_layout',
  'stereo',
  '-i',
  sample,
  '-map',
  '0:a:0',
  '-af',
  'asetpts=N/SR/TB',
  '-f',
  's16le',
  'pipe:1',
]);
assert.equal(decoded.length, PCM_BYTES);
assert.equal(hash(decoded), PCM_SHA);
const aac = execute([
  '-f',
  'lavfi',
  '-i',
  'aevalsrc=0.4*sin(2*PI*1000*t)|0.3*sin(2*PI*1800*t):s=48000:d=0.25',
  '-c:a',
  'libfdk_aac',
  '-b:a',
  '128k',
  '-f',
  'adts',
  'pipe:1',
]);
const pcm = execute(['-f', 'aac', '-i', 'pipe:0', '-f', 'f32le', 'pipe:1'], aac);
assert.equal(pcm.length % (CHANNELS * SAMPLE_SIZE), 0);
const frames = pcm.length / (CHANNELS * SAMPLE_SIZE);
assert.ok(frames >= MIN_FRAMES && frames <= MAX_FRAMES);
const energy = (channel, frequency) => {
  let real = 0;
  let imaginary = 0;
  for (let frame = 0; frame < frames; frame++) {
    const value = pcm.readFloatLE((frame * CHANNELS + channel) * SAMPLE_SIZE);
    assert.ok(Number.isFinite(value));
    const phase = (TAU * frequency * frame) / RATE;
    real += value * Math.cos(phase);
    imaginary += value * Math.sin(phase);
  }
  return real * real + imaginary * imaginary;
};
for (let channel = 0; channel < CHANNELS; channel++) {
  assert.ok(
    energy(channel, FREQUENCIES[channel]) > ENERGY_RATIO * energy(channel, REFERENCE_FREQUENCY),
  );
}
const shared = join(dirname(ffmpeg), 'libmpeghdec.so');
if (existsSync(shared)) {
  const elf = spawnSync('readelf', ['-d', shared], { encoding: 'utf8', timeout: TIMEOUT });
  assert.equal(elf.status, 0, elf.stderr);
  assert.ok(elf.stdout.includes('[libmpeghdec.so]'));
  assert.doesNotMatch(elf.stdout, /libstdc\+\+\.so/);
}
console.log(
  'MPEG-H: complete 60-second stereo PCM fingerprint and simultaneous FDK AAC stereo encoding/decoding passed',
);
