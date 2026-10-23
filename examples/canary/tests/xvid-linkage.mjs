import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const binary = process.env.FFMPEG;
assert.ok(binary);
const folder = mkdtempSync(join(tmpdir(), 'xvid-wrapper-'));
const width = 64;
const height = 64;
const pixels = width * height;
const chromaDivisor = 2;
const frameBytes = pixels + pixels / chromaDivisor;
const baseline = 24;
const levelStep = 12;
const neutral = 128;
const maxFrames = 14;
const maxBframes = 3;
const tolerance = 3;
const maxBuffer = 1_048_576;
const shortGop = 5;
const longGop = 300;
let cases = 0;
function ffmpeg(args) {
  return execFileSync(binary, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    timeout: 30_000,
    maxBuffer,
  });
}
function verifyFrames(source, actual, output, count) {
  assert.equal(actual.length, source.length, `${output}: natural EOF frame count`);
  for (let frame = 0; frame < count; frame++) {
    let error = 0;
    for (let pixel = 0; pixel < pixels; pixel++) {
      error += Math.abs(actual[frame * frameBytes + pixel] - source[frame * frameBytes + pixel]);
    }
    assert.ok(error / pixels <= tolerance, `${output}: authored frame ${frame} order/content`);
  }
}
for (let count = 1; count <= maxFrames; count++) {
  const source = Buffer.alloc(count * frameBytes, neutral);
  for (let frame = 0; frame < count; frame++) {
    source.fill(baseline + frame * levelStep, frame * frameBytes, frame * frameBytes + pixels);
  }
  const input = join(folder, `input-${count}.yuv`);
  writeFileSync(input, source);
  for (let bframes = 0; bframes <= maxBframes; bframes++) {
    for (const extension of ['avi', 'mp4']) {
      for (const gop of [shortGop, longGop]) {
        const output = join(folder, `output-${count}-${bframes}-${gop}.${extension}`);
        const decoded = `${output}.yuv`;
        ffmpeg([
          '-f',
          'rawvideo',
          '-pixel_format',
          'yuv420p',
          '-video_size',
          `${width}x${height}`,
          '-framerate',
          '25',
          '-i',
          input,
          '-c:v',
          'libxvid',
          '-bf',
          String(bframes),
          '-g',
          String(gop),
          '-q:v',
          '4',
          '-threads',
          '1',
          output,
        ]);
        ffmpeg([
          '-i',
          output,
          '-c:v',
          'rawvideo',
          '-pix_fmt',
          'yuv420p',
          '-fps_mode',
          'passthrough',
          '-f',
          'rawvideo',
          decoded,
        ]);
        const actual = readFileSync(decoded);
        verifyFrames(source, actual, output, count);
        cases++;
        console.log(
          `wrapper-pass frames=${count} max_bframes=${bframes} container=${extension} gop=${gop}`,
        );
      }
    }
  }
}
rmSync(folder, { recursive: true, force: true });
console.log(`Xvid authored-frame checks passed: ${cases}`);
