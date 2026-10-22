import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const directory = dirname(ffmpeg);
const TIMEOUT = 30000;
const MAX_OUTPUT = 4194304;
const WIDTH = 16;
const HEIGHT = 16;
const FRAMES = 3;
const CHANNELS = 3;
const RED = 255;
const components = ['libv4l1', 'libv4l2', 'libv4lconvert', 'libv4l2rds'];
function command(program, args, input) {
  const result = spawnSync(program, args, {
    input,
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
  assert.equal(result.signal, null, result.stderr?.toString());
  return result;
}
const devices = command(ffmpeg, ['-hide_banner', '-devices']);
assert.equal(devices.status, 0);
assert.match(devices.stdout.toString() + devices.stderr.toString(), /video4linux2,v4l2/);
const missing = command(ffmpeg, [
  '-nostdin',
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'v4l2',
  '-use_libv4l2',
  '1',
  '-i',
  '/ffb-owned-missing-camera',
  '-f',
  'null',
  '-',
]);
assert.notEqual(missing.status, 0);
assert.match(missing.stderr.toString(), /No such file|Cannot open/);
const input = Buffer.alloc(WIDTH * HEIGHT * CHANNELS * FRAMES);
for (let index = 0; index < input.length; index += CHANNELS) {
  input[index] = RED;
}
const decoded = command(
  ffmpeg,
  [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pixel_format',
    'rgb24',
    '-video_size',
    `${WIDTH}x${HEIGHT}`,
    '-framerate',
    '1',
    '-i',
    'pipe:0',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1',
  ],
  input,
);
assert.equal(decoded.status, 0, decoded.stderr.toString());
assert.deepEqual(decoded.stdout, input, 'All three authored frames must drain through natural EOF');
const shared = existsSync(join(directory, 'libv4l2.so.0'));
const device = readdirSync(directory).find((name) => /^libavdevice\.so\.\d+$/.test(name));
assert.ok(device);
const imports = command('readelf', ['-d', join(directory, device)]);
assert.equal(imports.status, 0);
assert.equal(imports.stdout.toString().includes('Shared library: [libv4l2.so.0]'), shared);
for (const component of components) {
  const path = join(directory, `${component}.so.0`);
  assert.equal(existsSync(path), shared);
  if (shared) {
    const dynamic = command('readelf', ['-d', path]);
    assert.equal(dynamic.status, 0);
    assert.match(dynamic.stdout.toString(), new RegExp(`SONAME.*\\[${component}\\.so\\.0\\]`));
    assert.doesNotMatch(dynamic.stdout.toString(), /NEEDED.*libstdc\+\+/);
  }
}
// Owned zero-coefficient fixtures exercise the actual staged native decoder
// programs. Neutral chroma verifies lengths and bytes, not U/V plane ordering.
const HEADER_BYTES = 16;
const WORD_BYTES = 4;
const WIDTH_OFFSET = 0;
const HEIGHT_OFFSET = 4;
const LENGTH_OFFSET = 12;
const NEUTRAL = 128;
const fixtures = [
  {
    name: 'ov511-decomp',
    width: 32,
    height: 16,
    length: 768,
    hex: 'ffffffffffffffff40400000400000400000400000400000400000400000400000400000400000400000400000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  },
  {
    name: 'ov518-decomp',
    width: 16,
    height: 8,
    length: 192,
    hex: 'ffffffffffffffff28a0028affffffff01010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101',
  },
];
const notice = readFileSync(join(directory, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
assert.match(notice, /GPL-2\.0-only/);
assert.match(notice, /Mark W\. McClelland/);
for (const fixture of fixtures) {
  const bytes = Buffer.from(fixture.hex, 'hex');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeInt32LE(fixture.width, WIDTH_OFFSET);
  header.writeInt32LE(fixture.height, HEIGHT_OFFSET);
  header.writeInt32LE(bytes.length, LENGTH_OFFSET);
  const packet = Buffer.concat([header, bytes]);
  const result = command(join(directory, fixture.name), [], Buffer.concat([packet, packet]));
  assert.equal(result.status, 0, result.stderr.toString());
  const expected = Buffer.alloc(WORD_BYTES + fixture.length, NEUTRAL);
  expected.writeInt32LE(fixture.length);
  assert.deepEqual(result.stdout, Buffer.concat([expected, expected]), fixture.name);
}
console.log(
  `V4L ${shared ? 'shared' : 'static'}: native device registration, clean no-hardware failure, CPU EOF and complete selected ABI payload passed`,
);
