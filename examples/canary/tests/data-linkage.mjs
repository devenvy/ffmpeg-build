import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-data-linkage-'));
const RATE = 16000;
const SAMPLE_BYTES = 2;
const FREQUENCY = 997;
const AMPLITUDE = 10000;
const MAX_OUTPUT = 4194304;
const FRAME_BYTES = 768;
const FRAMES = 8;
const MAX_PIXEL_ERROR = 5;
const RED = 32;
const GREEN = 64;
const BLUE = 96;
const RADIANS_PER_CYCLE = Math.PI + Math.PI;
const flags = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
const run = (program, args, input) => {
  const result = spawnSync(program, args, { input, timeout: 30000, maxBuffer: MAX_OUTPUT });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr?.toString());
  return result.stdout;
};
try {
  const pcm = Buffer.alloc(RATE * SAMPLE_BYTES);
  for (let index = 0; index < RATE; index++) {
    pcm.writeInt16LE(
      Math.round(AMPLITUDE * Math.sin((index * FREQUENCY * RADIANS_PER_CYCLE) / RATE)),
      index * SAMPLE_BYTES,
    );
  }
  const fixture = fileURLToPath(new URL('bzlib-matroska.py', import.meta.url));
  const source = join(work, 'authored.mkv');
  writeFileSync(source, run('python3', [fixture], pcm));
  const decoded = run(ffmpeg, [...flags, '-xerror', '-i', source, '-f', 's16le', '-']);
  assert.deepEqual(decoded, pcm, 'Matroska bzlib decoding must preserve every authored PCM sample');
  const corrupt = join(work, 'corrupt.mkv');
  writeFileSync(corrupt, run('python3', [fixture, '--corrupt'], pcm));
  const rejected = spawnSync(
    ffmpeg,
    [...flags, '-xerror', '-abort_on', 'empty_output', '-i', corrupt, '-f', 's16le', '-'],
    {
      timeout: 30000,
    },
  );
  assert.equal(rejected.error, undefined);
  assert.notEqual(rejected.status, 0, 'Strict corrupt-input decoding must fail');
  assert.equal(rejected.stdout.length, 0, 'A corrupt bzlib block must not produce PCM');
  const manifest = join(work, 'manifest.mpd');
  run(ffmpeg, [
    ...flags,
    '-f',
    'lavfi',
    '-i',
    'color=c=0x204060:size=16x16:rate=8',
    '-frames:v',
    String(FRAMES),
    '-c:v',
    'mpeg4',
    '-bf',
    '0',
    '-g',
    '4',
    '-f',
    'dash',
    '-seg_duration',
    '0.5',
    manifest,
  ]);
  const probe = JSON.parse(
    run(join(dirname(ffmpeg), 'ffprobe'), [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'stream=width,height,nb_read_frames',
      '-of',
      'json',
      manifest,
    ]),
  );
  assert.deepEqual(probe.streams, [{ width: 16, height: 16, nb_read_frames: String(FRAMES) }]);
  // Normal probing must preserve exactly one copy of every frame through EOF.
  const pixels = run(ffmpeg, [
    ...flags,
    '-i',
    manifest,
    '-map',
    '0:v:0',
    '-pix_fmt',
    'rgb24',
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-',
  ]);
  assert.equal(pixels.length, FRAME_BYTES * FRAMES);
  const expected = [RED, GREEN, BLUE];
  let difference = 0;
  for (let index = 0; index < pixels.length; index++) {
    difference += Math.abs(pixels[index] - expected[index % expected.length]);
  }
  assert.ok(difference / pixels.length < MAX_PIXEL_ERROR);
  const files = readdirSync(dirname(ffmpeg));
  const receipt = join(dirname(ffmpeg), 'RUNTIME-DEPENDENCIES.json');
  const systemLibraries = existsSync(receipt)
    ? JSON.parse(readFileSync(receipt, 'utf8')).libraries.map((library) => library.name)
    : [];
  const dynamic = files
    .filter((name) => /\.so(?:\.|$)/.test(name))
    .map((name) => run('readelf', ['-d', join(dirname(ffmpeg), name)]).toString())
    .join('\n');
  for (const library of ['bz2', 'xml2', 'z']) {
    const bundled = files.some((name) => new RegExp(`^lib${library}\\.so`).test(name));
    const system = systemLibraries.includes({ bz2: 'bzip2', xml2: 'libxml2', z: 'zlib' }[library]);
    assert.ok(!(bundled && system), `${library}: system provider must omit its build copy`);
    assert.equal(
      new RegExp(`NEEDED.*lib${library}\\.so`).test(dynamic),
      bundled || system,
      `${library}: selected dependency closure`,
    );
  }
  for (const name of files.filter((file) => /^libxml2\.so/.test(file))) {
    assert.doesNotMatch(
      run('nm', ['-D', '--defined-only', join(dirname(ffmpeg), name)]).toString(),
      /\b(?:inflate|deflate|crc32|adler32)\b/,
    );
  }
  console.log(
    'Matroska bzlib PCM, corrupt-block rejection, DASH XML pixels and linkage checks passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
