import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const TIMEOUT = 30000;
const MAX_OUTPUT = 8388608;
const WIDTH = 16;
const HEIGHT = 16;
const FRAMES = 3;
const CHANNELS = 3;
const BLUE_OFFSET = 2;
const MIN_RED = 250;
const MAX_OTHER = 3;
const execute = (program, args) =>
  spawnSync(program, args, {
    env: { ...process.env, LD_BIND_NOW: '1' },
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
const run = (args) => execute(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args]);
const hardware = run(['-hwaccels']);
assert.equal(hardware.status, 0, hardware.stderr.toString());
for (const name of ['drm', 'vaapi', 'qsv']) {
  assert.match(hardware.stdout.toString(), new RegExp(`\\b${name}\\b`));
}
const software = run([
  '-f',
  'lavfi',
  '-i',
  `color=red:s=${WIDTH}x${HEIGHT}:r=1`,
  '-frames:v',
  String(FRAMES),
  '-pix_fmt',
  'rgb24',
  '-f',
  'rawvideo',
  'pipe:1',
]);
assert.equal(software.status, 0, software.stderr.toString());
assert.equal(software.stdout.length, WIDTH * HEIGHT * CHANNELS * FRAMES);
for (let offset = 0; offset < software.stdout.length; offset += CHANNELS) {
  assert.ok(software.stdout[offset] >= MIN_RED);
  assert.ok(
    software.stdout[offset + 1] <= MAX_OTHER && software.stdout[offset + BLUE_OFFSET] <= MAX_OTHER,
  );
}
for (const device of ['drm=invalid:/dev/null', 'vaapi=invalid:/dev/null']) {
  const result = run([
    '-init_hw_device',
    device,
    '-f',
    'lavfi',
    '-i',
    'color=s=16x16',
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ]);
  assert.equal(result.signal, null, result.error?.message);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr.toString(), /device|display|DRM|argument/i);
}
const libraries = ['libdrm.so.2', 'libva.so.2', 'libva-drm.so.2', 'libvpl.so.2'];
for (const name of libraries) {
  const library = join(dirname(ffmpeg), name);
  if (existsSync(library)) {
    const dynamic = execute('readelf', ['-d', library]);
    assert.equal(dynamic.status, 0);
    assert.ok(dynamic.stdout.toString().includes(`[${name}]`));
    assert.doesNotMatch(dynamic.stdout.toString(), /libstdc\+\+\.so/);
  }
}
console.log(
  'Dispatchers: software pixels, enabled APIs, rejected non-device FDs and native shared ABI passed; no GPU assertion',
);
