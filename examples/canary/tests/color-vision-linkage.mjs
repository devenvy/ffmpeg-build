import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-cv-'));
const width = 7;
const frames = 3;
const firstCenter = 2;
const intensityStep = 64;
const area = width * width;
try {
  const input = Buffer.alloc(area * frames);
  const expected = Buffer.alloc(input.length);
  for (let frame = 0; frame < frames; frame++) {
    const center = frame + firstCenter;
    const value = intensityStep + frame * intensityStep;
    input[frame * area + center * width + center] = value;
    for (let row = center - 1; row <= center + 1; row++) {
      for (let column = center - 1; column <= center + 1; column++) {
        expected[frame * area + row * width + column] = value;
      }
    }
  }
  const path = join(work, 'owned.gray');
  writeFileSync(path, input);
  assert.deepEqual(readFileSync(path), input);
  const result = spawnSync(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'rawvideo',
      '-pixel_format',
      'gray',
      '-video_size',
      `${width}x${width}`,
      '-framerate',
      '1',
      '-i',
      path,
      '-vf',
      'ocv=dilate:3x3+1x1/rect|1',
      '-pixel_format',
      'gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    {
      timeout: 30000,
      killSignal: 'SIGKILL',
      maxBuffer: 8388608,
      env: { ...process.env, LD_BIND_NOW: '1' },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(result.stdout, expected, 'all authored morphology pixels and natural EOF');
  for (const [component, soname] of [
    ['libOpenColorIO', 'libOpenColorIO.so.2.6'],
    ['libopencv_core', 'libopencv_core.so.414'],
    ['libopencv_imgproc', 'libopencv_imgproc.so.414'],
  ]) {
    const library = join(dirname(ffmpeg), `${component}.so`);
    if (existsSync(library)) {
      const dynamic = spawnSync('readelf', ['-d', library], { encoding: 'utf8', timeout: 30000 });
      assert.equal(dynamic.status, 0, dynamic.stderr);
      assert.ok(dynamic.stdout.includes(`[${soname}]`), dynamic.stdout);
      assert.equal(
        dynamic.stdout.includes('libstdc++.so.6'),
        component === 'libOpenColorIO',
        dynamic.stdout,
      );
    }
  }
  console.log(
    'OpenCV: three owned morphology frames, exact pixels, natural EOF and native module SONAMEs passed',
  );
  await import('./ocio-dependencies.mjs');
} finally {
  rmSync(work, { recursive: true, force: true });
}
