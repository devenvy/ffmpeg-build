import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const WIDTH = 64;
const HEIGHT = 64;
const FRAMES = 3;
const CHANNELS = 3;
const FRAME_BYTES = WIDTH * HEIGHT * CHANNELS;
const HIGH = 192;
const LOW = 48;
const MID = 64;
const COLORS = [
  [HIGH, LOW, MID],
  [LOW, HIGH, MID],
  [LOW, MID, HIGH],
];
const MAX_ERROR = 8;
const work = mkdtempSync(join(tmpdir(), 'ffb-rav1e-'));
const execute = (args) => {
  const result = spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
    timeout: 120000,
    killSignal: 'SIGKILL',
    maxBuffer: 8388608,
    env: { ...process.env, LD_BIND_NOW: '1' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
};
const encode = (input, output) =>
  execute([
    ...input,
    '-an',
    '-c:v',
    'librav1e',
    '-speed',
    '10',
    '-qp',
    '40',
    '-threads',
    '1',
    '-rav1e-params',
    'low_latency=true:rdo_lookahead_frames=1',
    '-pix_fmt',
    'yuv420p',
    output,
  ]);
const decode = (path) =>
  execute(['-c:v', 'libdav1d', '-i', path, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1']);
const checkPixels = (actual, expected) => {
  assert.equal(actual.length, expected.length, 'all encoded frames drained through natural EOF');
  let error = 0;
  for (let index = 0; index < actual.length; index++) {
    error += Math.abs(actual[index] - expected[index]);
  }
  assert.ok(error / actual.length < MAX_ERROR, `mean RGB error ${error / actual.length}`);
};
try {
  const input = Buffer.alloc(FRAME_BYTES * FRAMES);
  for (let frame = 0; frame < FRAMES; frame++) {
    for (let offset = 0; offset < FRAME_BYTES; offset += CHANNELS) {
      for (let channel = 0; channel < CHANNELS; channel++) {
        input[frame * FRAME_BYTES + offset + channel] = COLORS[frame][channel];
      }
    }
  }
  const raw = join(work, 'owned.rgb');
  const encoded = join(work, 'owned.ivf');
  writeFileSync(raw, input);
  encode(
    [
      '-f',
      'rawvideo',
      '-pixel_format',
      'rgb24',
      '-video_size',
      `${WIDTH}x${HEIGHT}`,
      '-framerate',
      '3',
      '-i',
      raw,
    ],
    encoded,
  );
  assert.ok(readFileSync(encoded).length > 0);
  checkPixels(decode(encoded), input);

  // librsvg and rav1e initialize their independent Rust runtimes in this same FFmpeg process.
  const svg = join(work, 'owned.svg');
  const svgEncoded = join(work, 'svg.ivf');
  writeFileSync(
    svg,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><rect width="${WIDTH}" height="${HEIGHT}" fill="rgb(${COLORS[0].join(',')})"/></svg>`,
  );
  encode(['-f', 'image2', '-pattern_type', 'none', '-c:v', 'librsvg', '-i', svg], svgEncoded);
  checkPixels(decode(svgEncoded), input.subarray(0, FRAME_BYTES));
  const library = join(dirname(ffmpeg), 'librav1e.so');
  if (existsSync(library)) {
    const dynamic = spawnSync('readelf', ['-d', library], { encoding: 'utf8', timeout: 30000 });
    assert.equal(dynamic.status, 0, dynamic.stderr);
    assert.ok(dynamic.stdout.includes('[librav1e.so.0.8]'), dynamic.stdout);
  }
  console.log(
    'rav1e: three owned AV1 frames, dav1d reconstruction, natural EOF, same-process SVG/Rust coexistence and native SONAME passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
