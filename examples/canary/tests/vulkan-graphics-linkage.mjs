import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const TIMEOUT = 300000;
const MAX_OUTPUT = 8388608;
const WIDTH = 64;
const HEIGHT = 64;
const CHANNELS = 3;
const FRAMES = 5;
const MAX_PIXEL_ERROR = 30;
const execute = (program, args, environment = {}) =>
  spawnSync(program, args, {
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
    env: { ...process.env, LD_BIND_NOW: '1', ...environment },
  });
const run = (args, environment = {}) => {
  const result = execute(
    ffmpeg,
    ['-nostdin', '-hide_banner', '-loglevel', 'debug', ...args],
    environment,
  );
  assert.equal(result.status, 0, result.error?.message ?? result.stderr.toString());
  return result;
};
const source = ['-f', 'lavfi', '-i', 'testsrc2=size=128x128:rate=5:duration=1'];
const output = ['-pix_fmt', 'rgb24', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'];
const reference = run([
  ...source,
  '-vf',
  `scale=${WIDTH}:${HEIGHT}:flags=bilinear`,
  ...output,
]).stdout;
const result = run(
  [
    '-init_hw_device',
    'vulkan=vk:0',
    '-filter_hw_device',
    'vk',
    ...source,
    '-vf',
    `format=yuv420p,hwupload,libplacebo=w=${WIDTH}:h=${HEIGHT}:deband=0:peak_detect=0,hwdownload,format=yuv420p`,
    ...output,
  ],
  { LD_DEBUG: 'libs' },
);
assert.equal(reference.length, WIDTH * HEIGHT * CHANNELS * FRAMES);
assert.equal(result.stdout.length, reference.length);
let difference = 0;
for (let index = 0; index < reference.length; index++) {
  difference += Math.abs(reference[index] - result.stdout[index]);
}
assert.ok(difference / reference.length < MAX_PIXEL_ERROR);
const debug = result.stderr.toString();
assert.match(debug, /llvmpipe|lavapipe/i);
const folder = dirname(ffmpeg);
if (existsSync(join(folder, 'libvulkan.so.1'))) {
  assert.match(debug, /calling init: \/runtime\/libvulkan\.so/);
} else {
  assert.doesNotMatch(debug, /calling init: .*\/libvulkan\.so/);
}
const libraries = [
  ['libshaderc_shared.so.1', 'shaderc_'],
  ['libplacebo.so.360', 'pl_'],
];
for (const [name, prefix] of libraries) {
  const path = join(folder, name);
  if (existsSync(path)) {
    const dynamic = execute('readelf', ['-d', path]);
    assert.equal(dynamic.status, 0);
    assert.ok(dynamic.stdout.toString().includes(`[${name}]`));
    assert.doesNotMatch(dynamic.stdout.toString(), /libstdc\+\+\.so/);
    const symbols = execute('nm', ['-D', '--defined-only', path]);
    assert.equal(symbols.status, 0);
    const names = symbols.stdout
      .toString()
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).at(-1));
    assert.ok(names.length > 0 && names.every((symbol) => symbol.startsWith(prefix)));
  }
}
console.log(
  'Vulkan graphics: actual lavapipe upload/libplacebo/resize/download pixels, selected caller loader and native public ABI passed',
);
