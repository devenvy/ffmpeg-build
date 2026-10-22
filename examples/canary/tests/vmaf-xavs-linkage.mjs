import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-vmaf-xavs-'));
const WIDTH = 128;
const HEIGHT = 96;
const FRAMES = 16;
const CHANNELS = 3;
const SUBSAMPLE = 2;
const FRAME_BYTES = (WIDTH * HEIGHT * CHANNELS) / SUBSAMPLE;
const Y_OFFSET = 16;
const Y_RANGE = 220;
const X_STEP = 3;
const Y_STEP = 2;
const FRAME_STEP = 7;
const CHROMA_MIDDLE = 128;
const TIMEOUT = 60000;
const MAX_OUTPUT = 8388608;
const MINIMUM_IDENTICAL = 90;
const MINIMUM_SCORE_GAP = 1;
const MAX_PIXEL_ERROR = 12;
const DELAYED_FRAMES = 2;
const reference = Buffer.alloc(FRAME_BYTES * FRAMES, CHROMA_MIDDLE);
for (let frame = 0; frame < FRAMES; frame++) {
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      reference[frame * FRAME_BYTES + y * WIDTH + x] =
        Y_OFFSET + ((x * X_STEP + y * Y_STEP + frame * FRAME_STEP) % Y_RANGE);
    }
  }
}
const execute = (program, args) =>
  spawnSync(program, args, {
    env: { ...process.env, LD_BIND_NOW: '1' },
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
const run = (args) => {
  const result = execute(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args]);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
};
const input = (file) => [
  '-f',
  'rawvideo',
  '-pixel_format',
  'yuv420p',
  '-video_size',
  `${WIDTH}x${HEIGHT}`,
  '-framerate',
  '25',
  '-i',
  file,
];
const metric = (distorted, name) => {
  const output = join(work, `${name}.json`);
  run([
    ...input(distorted),
    ...input(join(work, 'reference.yuv')),
    '-filter_complex',
    `[0:v][1:v]libvmaf=log_fmt=json:log_path=${output}:n_threads=1`,
    '-f',
    'null',
    '-',
  ]);
  const result = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(result.frames.length, FRAMES);
  for (const [index, frame] of result.frames.entries()) {
    assert.equal(frame.frameNum, index);
    assert.ok(Number.isFinite(frame.metrics.vmaf));
  }
  const score = result.pooled_metrics.vmaf.mean;
  assert.ok(Number.isFinite(score));
  return score;
};
try {
  const path = join(work, 'reference.yuv');
  writeFileSync(path, reference);
  writeFileSync(join(work, 'degraded.yuv'), Buffer.alloc(reference.length, CHROMA_MIDDLE));
  const identical = metric(path, 'identical');
  const degraded = metric(join(work, 'degraded.yuv'), 'degraded');
  assert.ok(
    identical > MINIMUM_IDENTICAL && identical > degraded + MINIMUM_SCORE_GAP,
    `VMAF score ordering: ${identical} vs ${degraded}`,
  );
  for (const bframes of [0, DELAYED_FRAMES]) {
    const encoded = join(work, `owned-bf${bframes}.cavs`);
    run([
      ...input(path),
      '-frames:v',
      String(FRAMES),
      '-c:v',
      'libxavs',
      '-bf',
      String(bframes),
      '-g',
      '8',
      '-threads',
      '1',
      '-q:v',
      '5',
      '-f',
      'cavsvideo',
      encoded,
    ]);
    assert.ok(readFileSync(encoded).length > 0);
    const decoded = run([
      '-i',
      encoded,
      '-fps_mode',
      'passthrough',
      '-pix_fmt',
      'yuv420p',
      '-f',
      'rawvideo',
      'pipe:1',
    ]);
    assert.equal(
      decoded.length,
      reference.length,
      `AVS bf${bframes}: full decoder EOF frame count`,
    );
    let error = 0;
    for (let index = 0; index < reference.length; index++) {
      error += Math.abs(reference[index] - decoded[index]);
    }
    assert.ok(
      error / reference.length < MAX_PIXEL_ERROR,
      `AVS bf${bframes}: pixel error ${error / reference.length}`,
    );
  }
  for (const [name, soname, prefix] of [
    ['libvmaf.so', 'libvmaf.so.3', 'vmaf_'],
    ['libxavs.so', 'libxavs.so.1', 'xavs_'],
  ]) {
    const library = join(dirname(ffmpeg), name);
    if (existsSync(library)) {
      const dynamic = execute('readelf', ['-d', library]);
      assert.equal(dynamic.status, 0);
      assert.ok(dynamic.stdout.toString().includes(`[${soname}]`));
      assert.doesNotMatch(dynamic.stdout.toString(), /libstdc\+\+\.so/);
      const symbols = execute('nm', ['-D', '--defined-only', library]);
      assert.equal(symbols.status, 0);
      for (const line of symbols.stdout.toString().trim().split('\n')) {
        assert.ok(line.trim().split(/\s+/).at(-1).startsWith(prefix), line);
      }
    }
  }
  console.log(
    'VMAF/AVS: all16 finite built-in model scores, degradation ordering, actual AVS bf0/bf2 encode/decode EOF pixels and private native ELF closure passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
