import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const WIDTH = 64;
const HEIGHT = 48;
const CHANNELS = 3;
const FRAME_BYTES = WIDTH * HEIGHT * CHANNELS;
const LEFT = 16;
const TOP = 12;
const RIGHT = 48;
const BOTTOM = 36;
const MAX_CHANNEL = 255;
const TIMEOUT = 30000;
const MAX_OUTPUT = 8388608;
const execute = (program, args) =>
  spawnSync(program, args, {
    env: { ...process.env, LD_BIND_NOW: '1' },
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
const render = (script) => {
  const result = execute(ffmpeg, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=black:s=${WIDTH}x${HEIGHT}:r=1,format=rgb24`,
    '-vf',
    `drawvg=${script},format=rgb24`,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length, FRAME_BYTES);
  return result.stdout;
};
const rectangle = render('rect 16 12 32 24 setcolor red fill');
for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    const offset = (y * WIDTH + x) * CHANNELS;
    const inside = x >= LEFT && x < RIGHT && y >= TOP && y < BOTTOM;
    assert.deepEqual(
      [...rectangle.subarray(offset, offset + CHANNELS)],
      inside ? [MAX_CHANNEL, 0, 0] : [0, 0, 0],
    );
  }
}
const translated = render('translate 16 12 rect 0 0 32 24 setcolor red fill');
assert.deepEqual(translated, rectangle);
const library = join(dirname(ffmpeg), 'libpixman-1.so.0');
if (existsSync(library)) {
  const dynamic = execute('readelf', ['-d', library]);
  assert.equal(dynamic.status, 0);
  assert.match(dynamic.stdout.toString(), /\[libpixman-1\.so\.0\]/);
  assert.doesNotMatch(dynamic.stdout.toString(), /libstdc\+\+\.so/);
  const symbols = execute('nm', ['-D', '--defined-only', library]);
  assert.equal(symbols.status, 0);
  assert.match(symbols.stdout.toString(), /\bpixman_image_composite32\b/);
}
console.log(
  'Pixman: actual drawvg/Cairo rectangle pixels and equivalent translated geometry passed',
);
