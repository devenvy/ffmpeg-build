import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const assets = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'ffb-media-filters-'));
const WIDTH = 160;
const HEIGHT = 128;
const CHANNELS = 3;
const BYTE_RANGE = 256;
const FLOAT_BYTES = 4;
const STEREO_CHANNELS = 2;
const TIMEOUT = 60000;
const MAX_OUTPUT = 8388608;
const IMPULSE_FRAME = 64;
const GAIN_DB = -3;
const DB_AMPLITUDE = 20;
const EPSILON = 0.000005;
const { offsets: OFFSETS } = JSON.parse(
  readFileSync(join(assets, 'stabilization-fixture.json'), 'utf8'),
);
const DB_BASE = 10;
const EDGE_GRAY = 16;
const TILE_SIZE = 8;
const SEARCH_RADIUS = 6;
const MEASURE_MARGIN = 32;
const MEASURE_STEP = 3;
const MAX_RESIDUAL_RATIO = 0.6;
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
const run = (args) =>
  command(ffmpeg, [
    '-y',
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-filter_threads',
    '1',
    ...args,
  ]);

const sofa = (asset = 'sofa.base64', hashField = 'sha256') => {
  const metadata = JSON.parse(readFileSync(join(assets, 'sofa-fixture.json'), 'utf8'));
  const bytes = Buffer.from(readFileSync(join(assets, asset), 'utf8'), 'base64');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata[hashField]);
  const file = join(work, 'authored.sofa');
  writeFileSync(file, bytes);
  const samples = Buffer.alloc(metadata.frames * FLOAT_BYTES);
  samples.writeFloatLE(1, IMPULSE_FRAME * FLOAT_BYTES);
  const input = join(work, 'impulse.f32');
  writeFileSync(input, samples);
  const gain = DB_BASE ** (GAIN_DB / DB_AMPLITUDE);
  for (const type of ['time', 'freq']) {
    const output = run([
      '-f',
      'f32le',
      '-ar',
      String(metadata.sampleRate),
      '-ac',
      '1',
      '-i',
      input,
      '-af',
      `sofalizer=sofa=${file}:type=${type}:normalize=0:minphase=0:interpolate=0:gain=0`,
      '-f',
      'f32le',
      '-acodec',
      'pcm_f32le',
      'pipe:1',
    ]);
    assert.equal(output.length, samples.length * STEREO_CHANNELS);
    for (let frame = 0; frame < metadata.frames; ++frame) {
      const left = output.readFloatLE(frame * STEREO_CHANNELS * FLOAT_BYTES);
      const right = output.readFloatLE((frame * STEREO_CHANNELS + 1) * FLOAT_BYTES);
      const expectedLeft = frame === IMPULSE_FRAME ? metadata.leftImpulse * gain : 0;
      const expectedRight =
        frame === IMPULSE_FRAME + metadata.rightDelaySamples ? metadata.rightImpulse * gain : 0;
      assert.ok(Math.abs(left - expectedLeft) < EPSILON, `${type}: left impulse ${frame}`);
      assert.ok(Math.abs(right - expectedRight) < EPSILON, `${type}: right impulse ${frame}`);
    }
    console.log(
      `sofalizer ${type}: ${metadata.frames} complete frames and exact authored impulse/delay/gain passed`,
    );
  }
};

const lens = () => {
  const frames = 3;
  const X_STEP = 3;
  const Y_STEP = 7;
  const COLOR_STEP = 53;
  const FRAME_STEP = 17;
  const input = Buffer.alloc(WIDTH * HEIGHT * CHANNELS * frames);
  for (let offset = 0; offset < input.length; ++offset) {
    const channel = offset % CHANNELS;
    const pixel = Math.floor(offset / CHANNELS);
    const x = pixel % WIDTH;
    const y = Math.floor(pixel / WIDTH) % HEIGHT;
    const frame = Math.floor(pixel / (WIDTH * HEIGHT));
    input[offset] =
      (x * X_STEP + y * Y_STEP + channel * COLOR_STEP + frame * FRAME_STEP) % BYTE_RANGE;
  }
  const file = join(work, 'lens.rgb');
  writeFileSync(file, input);
  const database = join(work, 'lens-db');
  command('mkdir', ['-p', database]);
  const xml = readFileSync(join(assets, 'lens.xml'), 'utf8');
  const outputs = [];
  for (const coefficient of ['0', '0.15']) {
    writeFileSync(join(database, 'authored.xml'), xml.replace('k1="0.15"', `k1="${coefficient}"`));
    outputs.push(
      run([
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-s',
        `${WIDTH}x${HEIGHT}`,
        '-i',
        file,
        '-vf',
        `lensfun=make=FFB:model=Test Camera:lens_model=Test Lens:db_path=${database}:focal_length=35:aperture=4:focus_distance=10:mode=geometry:scale=1:interpolation=nearest`,
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ]),
    );
  }
  assert.deepEqual(outputs[0], input, 'zero lens calibration preserves all authored pixels');
  assert.equal(
    outputs[1].length,
    input.length,
    'nonzero calibration preserves complete frame count',
  );
  assert.notDeepEqual(outputs[1], input, 'nonzero calibration changes coordinate mapping');
  console.log(
    `lensfun: ${frames} complete frames, identity pixels and nonzero authored calibration passed`,
  );
};

const measuredOffset = (frame, reference) => {
  let bestError = Infinity;
  let bestOffset = 0;
  for (let dx = -SEARCH_RADIUS; dx <= SEARCH_RADIUS; ++dx) {
    let error = 0;
    for (let y = MEASURE_MARGIN; y < HEIGHT - MEASURE_MARGIN; y += MEASURE_STEP) {
      for (let x = MEASURE_MARGIN; x < WIDTH - MEASURE_MARGIN; x += MEASURE_STEP) {
        error += Math.abs(frame[y * WIDTH + x] - reference[y * WIDTH + x - dx]);
      }
    }
    if (error < bestError) {
      bestError = error;
      bestOffset = dx;
    }
  }
  return bestOffset;
};

const stabilize = () => {
  const tiles = Buffer.from(
    readFileSync(join(assets, 'stabilization-texture.base64'), 'utf8'),
    'base64',
  );
  assert.equal(tiles.length, (WIDTH / TILE_SIZE) * (HEIGHT / TILE_SIZE));
  const reference = Buffer.alloc(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; ++y) {
    for (let x = 0; x < WIDTH; ++x) {
      reference[y * WIDTH + x] =
        tiles[Math.floor(y / TILE_SIZE) * (WIDTH / TILE_SIZE) + Math.floor(x / TILE_SIZE)];
    }
  }
  const frames = OFFSETS.map((dx) => {
    const frame = Buffer.alloc(reference.length);
    for (let y = 0; y < HEIGHT; ++y) {
      for (let x = 0; x < WIDTH; ++x) {
        frame[y * WIDTH + x] =
          x - dx < 0 || x - dx >= WIDTH ? EDGE_GRAY : reference[y * WIDTH + x - dx];
      }
    }
    assert.equal(measuredOffset(frame, reference), dx, 'authored displacement estimator');
    return frame;
  });
  const input = join(work, 'shaky.gray');
  writeFileSync(input, Buffer.concat(frames));
  const source = [
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-s',
    `${WIDTH}x${HEIGHT}`,
    '-r',
    '12',
    '-i',
    input,
  ];
  const motion = join(work, 'motion.trf');
  run([
    ...source,
    '-vf',
    `vidstabdetect=shakiness=8:accuracy=15:stepsize=6:mincontrast=0.1:result=${motion}`,
    '-f',
    'null',
    '-',
  ]);
  assert.ok(readFileSync(motion).length > 0);
  const output = run([
    ...source,
    '-vf',
    `vidstabtransform=input=${motion}:smoothing=5:zoom=0:optzoom=0:interpol=0:crop=black`,
    '-pix_fmt',
    'gray',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  assert.equal(output.length, reference.length * OFFSETS.length);
  const offsets = OFFSETS.map((_, index) =>
    measuredOffset(
      output.subarray(index * reference.length, (index + 1) * reference.length),
      reference,
    ),
  );
  const residual = offsets.slice(1, -1).reduce((sum, offset) => sum + Math.abs(offset), 0);
  const original = OFFSETS.slice(1, -1).reduce((sum, offset) => sum + Math.abs(offset), 0);
  assert.ok(residual < original * MAX_RESIDUAL_RATIO, `stabilized offsets ${offsets.join(',')}`);
  console.log(
    `vidstab: ${OFFSETS.length} complete frames, authored jitter ${original} reduced to ${residual}`,
  );
};

const elf = () => {
  const folder = dirname(ffmpeg);
  const installed = readdirSync(folder);
  const filter = installed.find((name) => name.startsWith('libavfilter.so.'));
  assert.ok(filter);
  const parents = command('readelf', ['-d', join(folder, filter)]).toString();
  for (const soname of ['libmysofa.so.1', 'libvidstab.so.1.2', 'liblensfun.so.2']) {
    assert.equal(
      parents.includes(`[${soname}]`),
      installed.includes(soname),
      `${soname}: selected mode`,
    );
    if (installed.includes(soname)) {
      const dynamic = command('readelf', ['-d', join(folder, soname)]).toString();
      assert.match(dynamic, /SONAME/u);
      assert.doesNotMatch(dynamic, /libstdc\+\+\.so/u);
      const symbols = command('nm', ['-D', '--defined-only', join(folder, soname)]).toString();
      assert.doesNotMatch(symbols, /\b_Z(?:St|N[KOV]?St|T[ISV]N?St)/u, soname);
    }
  }
};

try {
  sofa();
  sofa('sofa-compressed.base64', 'compressedSha256');
  lens();
  stabilize();
  elf();
} finally {
  rmSync(work, { recursive: true, force: true });
}
