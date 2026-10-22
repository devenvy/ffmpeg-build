import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const TIMEOUT = 120000;
const MAX_OUTPUT = 8388608;
const WIDTH = 64;
const HEIGHT = 32;
const FRAMES = 4;
const PLANES = 3;
const SUBSAMPLE = 2;
const PLANE_SEED = 61;
const ROW_FACTOR = 7;
const COLUMN_FACTOR = 3;
const FRAME_FACTOR = 11;
const SAMPLE_VALUES = 256;
const input = Buffer.alloc((WIDTH * HEIGHT * PLANES * FRAMES) / SUBSAMPLE);
let offset = 0;
for (let frame = 0; frame < FRAMES; frame++) {
  for (let plane = 0; plane < PLANES; plane++) {
    const width = plane ? WIDTH / SUBSAMPLE : WIDTH;
    const height = plane ? HEIGHT / SUBSAMPLE : HEIGHT;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        input[offset++] =
          (plane * PLANE_SEED + y * ROW_FACTOR + x * COLUMN_FACTOR + frame * FRAME_FACTOR) %
          SAMPLE_VALUES;
      }
    }
  }
}
assert.equal(offset, input.length);
const execute = (program, args, options = {}) =>
  spawnSync(program, args, {
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
    env: { ...process.env, LD_BIND_NOW: '1' },
    ...options,
  });
const source = [
  '-f',
  'rawvideo',
  '-pixel_format',
  'yuv420p',
  '-video_size',
  `${WIDTH}x${HEIGHT}`,
  '-framerate',
  '4',
  '-i',
  'pipe:0',
];
const output = ['-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1'];
const run = (args, options = {}) =>
  execute(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'debug', ...args], {
    input,
    ...options,
  });
const reference = run([...source, '-vf', 'transpose=clock', ...output]);
assert.equal(reference.status, 0, reference.stderr.toString());
assert.equal(reference.stdout.length, input.length);
const compute = run([
  '-init_hw_device',
  'opencl=ocl:0.0',
  '-filter_hw_device',
  'ocl',
  ...source,
  '-vf',
  'format=yuv420p,hwupload,transpose_opencl=dir=clock,hwdownload,format=yuv420p',
  ...output,
]);
assert.equal(compute.status, 0, compute.error?.message ?? compute.stderr.toString());
assert.match(compute.stderr.toString(), /Portable Computing Language|pocl/i);
assert.deepEqual(compute.stdout, reference.stdout);
const passthrough = run([...source, '-vf', 'lcevc', ...output]);
assert.equal(passthrough.status, 0, passthrough.error?.message ?? passthrough.stderr.toString());
assert.deepEqual(passthrough.stdout, input);
const empty = mkdtempSync(join(tmpdir(), 'ffb-opencl-empty-'));
try {
  const missing = run(
    ['-init_hw_device', 'opencl=missing:0.0', ...source, '-frames:v', '1', '-f', 'null', '-'],
    {
      env: { ...process.env, LD_BIND_NOW: '1', OCL_ICD_VENDORS: empty, OCL_ICD_FILENAMES: '' },
    },
  );
  assert.equal(missing.signal, null, missing.error?.message);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr.toString(), /platform|device|OpenCL/i);
} finally {
  rmSync(empty, { recursive: true, force: true });
}
for (const name of ['libOpenCL.so.1', 'liblcevc_dec_api.so.4', 'liblcevc_dec_pipeline_cpu.so.1']) {
  const library = join(dirname(ffmpeg), name);
  if (existsSync(library)) {
    const dynamic = execute('readelf', ['-d', library]);
    assert.equal(dynamic.status, 0);
    assert.ok(dynamic.stdout.toString().includes(`[${name}]`));
    assert.doesNotMatch(dynamic.stdout.toString(), /libstdc\+\+\.so/);
  }
}
console.log(
  'Compute: four exact PoCL transpose frames, driver absence, and byte-exact LCEVC CPU passthrough through natural EOF passed',
);
