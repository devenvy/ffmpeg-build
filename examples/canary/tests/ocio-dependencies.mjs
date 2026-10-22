import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-ocio-'));
const TIMEOUT = 30000;
const MAX_OUTPUT = 8388608;
const FLOAT_BYTES = 4;
const CHANNELS = 3;
const WIDTH = 4;
const HEIGHT = 2;
const PIXELS = WIDTH * HEIGHT;
const TOLERANCE = 0.000002;
const HALF = 0.5;
const fixture = JSON.parse(readFileSync(new URL('./ocio-colors.json', import.meta.url), 'utf8'));
const OFFSETS = fixture.offsets;
const PLANES = fixture.planes;
const colors = fixture.colors;
const config = `ocio_profile_version: 2
search_path: luts
strictparsing: true
roles:
  default: source
  scene_linear: source
file_rules:
  - !<Rule> {name: Default, colorspace: source}
displays:
  owned:
    - !<View> {name: result, colorspace: transformed}
colorspaces:
  - !<ColorSpace>
    name: source
    bitdepth: 32f
    isdata: false
    allocation: uniform
  - !<ColorSpace>
    name: transformed
    bitdepth: 32f
    isdata: false
    allocation: uniform
    from_scene_reference: !<FileTransform> {src: ./affine.cube, interpolation: linear}
`;
const lut = `TITLE "Owned affine RGB transform"
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0.125 0.250 0.375
0.625 0.250 0.375
0.125 0.750 0.375
0.625 0.750 0.375
0.125 0.250 0.875
0.625 0.250 0.875
0.125 0.750 0.875
0.625 0.750 0.875
`;
const execute = (program, args) =>
  spawnSync(program, args, {
    env: { ...process.env, LD_BIND_NOW: '1' },
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
const render = (path) =>
  execute(ffmpeg, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pixel_format',
    'gbrpf32le',
    '-video_size',
    `${WIDTH}x${HEIGHT}`,
    '-framerate',
    '1',
    '-i',
    join(work, 'input.bin'),
    '-vf',
    `ocio=config=${path}:input=source:output=transformed:format=gbrpf32le`,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
const check = (path) => {
  const result = render(path);
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length, PIXELS * CHANNELS * FLOAT_BYTES);
  for (let plane = 0; plane < CHANNELS; plane++) {
    const channel = PLANES[plane];
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      const actual = result.stdout.readFloatLE((plane * PIXELS + pixel) * FLOAT_BYTES);
      const expected = colors[pixel % colors.length][channel] * HALF + OFFSETS[channel];
      assert.ok(
        Number.isFinite(actual) && Math.abs(actual - expected) < TOLERANCE,
        `${path}: pixel ${pixel} channel ${channel}: ${actual} != ${expected}`,
      );
    }
  }
  return result.stdout;
};
try {
  const folder = join(work, 'unpacked');
  mkdirSync(join(folder, 'luts'), { recursive: true });
  writeFileSync(join(folder, 'config.ocio'), config);
  writeFileSync(join(folder, 'luts/affine.cube'), lut);
  const input = Buffer.alloc(PIXELS * CHANNELS * FLOAT_BYTES);
  for (let plane = 0; plane < CHANNELS; plane++) {
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      input.writeFloatLE(
        colors[pixel % colors.length][PLANES[plane]],
        (plane * PIXELS + pixel) * FLOAT_BYTES,
      );
    }
  }
  writeFileSync(join(work, 'input.bin'), input);
  const direct = check(join(folder, 'config.ocio'));
  const author = execute('python3', [
    '-c',
    `import pathlib, sys, zipfile
root=pathlib.Path(sys.argv[1])
with zipfile.ZipFile(root/'owned.ocioz','w',zipfile.ZIP_DEFLATED) as archive:
    archive.write(root/'unpacked/config.ocio','config.ocio')
    archive.write(root/'unpacked/luts/affine.cube','luts/affine.cube')
with zipfile.ZipFile(root/'missing-lut.ocioz','w',zipfile.ZIP_DEFLATED) as archive:
    archive.write(root/'unpacked/config.ocio','config.ocio')
`,
    work,
  ]);
  assert.equal(author.status, 0, author.stderr.toString());
  rmSync(folder, { recursive: true, force: true });
  assert.deepEqual(check(join(work, 'owned.ocioz')), direct);
  const missing = render(join(work, 'missing-lut.ocioz'));
  assert.equal(missing.error, undefined);
  assert.ok(missing.status !== 0 && missing.status !== null);
  console.log(
    'OCIO: authored YAML/config archive, relative LUT normalization, exact float pixels and missing archived LUT rejection passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
