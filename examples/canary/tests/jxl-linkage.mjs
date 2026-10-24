import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const folder = mkdtempSync(join(tmpdir(), 'ffb-jxl-'));
const WIDTH = 32;
const HEIGHT = 24;
const FRAMES = 3;
const BYTE_RANGE = 256;
const WORD_RANGE = 65536;
const TIMEOUT = 60000;
const MAX_OUTPUT = 8388608;
const PIXEL_STEP = 37;
const ROW_STEP = 19;
const FRAME_THREADS = 2;
const MAX_LOSSY_MEAN_ERROR = 3;
const RGB_CHANNELS = 3;
const BLUE_CHANNEL = 2;
const SMOOTH_X_STEP = 4;
const SMOOTH_Y_STEP = 5;
const SMOOTH_FRAME_STEP = 30;
const smoothPixels = () => {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * RGB_CHANNELS * FRAMES);
  for (let frame = 0; frame < FRAMES; ++frame) {
    for (let y = 0; y < HEIGHT; ++y) {
      for (let x = 0; x < WIDTH; ++x) {
        const offset = ((frame * HEIGHT + y) * WIDTH + x) * RGB_CHANNELS;
        pixels[offset] = x * SMOOTH_X_STEP;
        pixels[offset + 1] = y * SMOOTH_Y_STEP;
        pixels[offset + BLUE_CHANNEL] = frame * SMOOTH_FRAME_STEP;
      }
    }
  }
  return pixels;
};
const command = (program, args) => {
  const result = spawnSync(program, args, { timeout: TIMEOUT, maxBuffer: MAX_OUTPUT });
  assert.equal(
    result.status,
    0,
    `${program}: ${result.error?.message ?? result.stderr?.toString()}`,
  );
  assert.equal(result.signal, null);
  return result.stdout;
};
const run = (args) => command(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args]);
try {
  for (const format of [
    { name: 'rgb24', channels: 3, bytes: 1 },
    { name: 'rgba', channels: 4, bytes: 1 },
    { name: 'rgb48le', channels: 3, bytes: 2 },
  ]) {
    const pixels = Buffer.alloc(WIDTH * HEIGHT * format.channels * format.bytes * FRAMES);
    for (let offset = 0; offset < pixels.length; offset += format.bytes) {
      const value =
        (offset * PIXEL_STEP + Math.floor(offset / WIDTH) * ROW_STEP) %
        (format.bytes === 1 ? BYTE_RANGE : WORD_RANGE);
      if (format.bytes === 1) {
        pixels[offset] = value;
      } else {
        pixels.writeUInt16LE(value, offset);
      }
    }
    const input = join(folder, `${format.name}.raw`);
    const sequence = join(folder, `${format.name}-%02d.jxl`);
    writeFileSync(input, pixels);
    for (const threads of [1, FRAME_THREADS]) {
      run([
        '-y',
        '-f',
        'rawvideo',
        '-pixel_format',
        format.name,
        '-video_size',
        `${WIDTH}x${HEIGHT}`,
        '-framerate',
        '1',
        '-i',
        input,
        '-frames:v',
        String(FRAMES),
        '-c:v',
        'libjxl',
        '-threads',
        String(threads),
        '-distance',
        '0',
        sequence,
      ]);
      const decoded = run([
        '-c:v',
        'libjxl',
        '-threads',
        String(threads),
        '-framerate',
        '1',
        '-i',
        sequence,
        '-f',
        'rawvideo',
        '-pix_fmt',
        format.name,
        'pipe:1',
      ]);
      assert.deepEqual(
        decoded,
        pixels,
        `${format.name}, threads=${threads}: lossless pixels and EOF`,
      );
    }
    console.log(`JPEG XL ${format.name}: ${FRAMES} byte-exact frames, threads 1/2`);
    if (format.name === 'rgb24') {
      const smooth = smoothPixels();
      writeFileSync(input, smooth);
      run([
        '-y',
        '-f',
        'rawvideo',
        '-pixel_format',
        format.name,
        '-video_size',
        `${WIDTH}x${HEIGHT}`,
        '-framerate',
        '1',
        '-i',
        input,
        '-frames:v',
        String(FRAMES),
        '-c:v',
        'libjxl',
        '-threads',
        String(FRAME_THREADS),
        '-distance',
        '1',
        sequence,
      ]);
      const lossy = run([
        '-c:v',
        'libjxl',
        '-i',
        sequence,
        '-f',
        'rawvideo',
        '-pix_fmt',
        format.name,
        'pipe:1',
      ]);
      assert.equal(lossy.length, pixels.length);
      let error = 0;
      for (let offset = 0; offset < pixels.length; ++offset) {
        error += Math.abs(smooth[offset] - lossy[offset]);
      }
      const mean = error / pixels.length;
      assert.ok(mean < MAX_LOSSY_MEAN_ERROR, `Lossy pixel mean error ${mean}`);
      console.log(`JPEG XL lossy: ${FRAMES} complete frames, mean pixel error ${mean}`);
    }
  }
  const invalid = join(folder, 'invalid.jxl');
  writeFileSync(invalid, 'authored invalid JPEG XL input');
  const rejected = spawnSync(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-c:v',
      'libjxl',
      '-i',
      invalid,
      '-f',
      'null',
      '-',
    ],
    { timeout: TIMEOUT },
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.signal, null);
  const libraryFolder = dirname(ffmpeg);
  let hasJxlDso = false;
  let hasSystemCxx = false;
  for (const name of readdirSync(libraryFolder).filter((entry) =>
    /^(?:libjxl(?:_threads|_cms)?|libhwy|libbrotli(?:common|dec|enc))\.so\./u.test(entry),
  )) {
    const library = join(libraryFolder, name);
    const dynamic = command('readelf', ['-d', library]).toString();
    assert.match(dynamic, /SONAME/u, name);
    if (name.startsWith('libjxl')) {
      hasJxlDso = true;
      hasSystemCxx ||= dynamic.includes('libstdc++.so.6');
      console.log(`${name}: native SONAME and system runtime dependency checked`);
    } else {
      assert.doesNotMatch(dynamic, /libstdc\+\+\.so/u, name);
      const exported = command('nm', ['-D', '--defined-only', '--demangle', library]).toString();
      assert.doesNotMatch(exported, /\b(?:std::|__gnu_cxx::)/u, name);
      console.log(`${name}: SONAME and private C++ runtime checked`);
    }
  }
  if (hasJxlDso) {
    assert.ok(hasSystemCxx, 'JPEG XL native system C++ runtime dependency');
  }
} finally {
  rmSync(folder, { recursive: true, force: true });
}
