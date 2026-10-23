import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const folder = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(folder, 'uavs3d-fixture.json'), 'utf8'));
const encoded = Buffer.from(readFileSync(join(folder, 'uavs3d.base64'), 'utf8'), 'base64');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(encoded), fixture.encodedSha256);
const work = mkdtempSync(join(tmpdir(), 'ffb-uavs3d-'));
const TIMEOUT = 30000;
const MAX_OUTPUT = 8388608;
const CHROMA_DIVISOR = 2;
const PUBLIC_EXPORTS = 6;
const FRAME_THREADS = 2;
const FLAGS = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
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
try {
  const input = join(work, 'authored.avs3');
  writeFileSync(input, encoded);
  for (const threads of [1, FRAME_THREADS]) {
    const output = join(work, `decoded-${threads}.yuv`);
    // Upstream prints its creation banner on stdout, so keep media in a file.
    command(ffmpeg, [
      ...FLAGS,
      '-threads',
      String(threads),
      '-c:v',
      'libuavs3d',
      '-f',
      'avs3',
      '-i',
      input,
      '-map',
      '0:v:0',
      '-fps_mode',
      'passthrough',
      '-pix_fmt',
      fixture.pixelFormat,
      '-f',
      'rawvideo',
      output,
    ]);
    const decoded = readFileSync(output);
    const frameBytes =
      fixture.width * fixture.height + (fixture.width * fixture.height) / CHROMA_DIVISOR;
    assert.equal(
      decoded.length,
      frameBytes * fixture.frames,
      'All authored AVS3 frames must decode through EOF',
    );
    assert.equal(
      sha(decoded),
      fixture.decodedSha256,
      'Decoder pixels must match the encoder reconstruction exactly',
    );
    console.log(
      `AVS3 ${threads} threads: all ${fixture.frames} authored frames match reconstruction`,
    );
  }
  const invalid = join(work, 'invalid.avs3');
  writeFileSync(invalid, 'This is authored invalid AVS3 input.');
  const rejected = spawnSync(
    ffmpeg,
    [...FLAGS, '-c:v', 'libuavs3d', '-f', 'avs3', '-i', invalid, '-f', 'null', '-'],
    { timeout: TIMEOUT, maxBuffer: MAX_OUTPUT },
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.signal, null, rejected.stderr?.toString());

  const files = readdirSync(dirname(ffmpeg));
  const bundled = files.filter((file) => /^libuavs3d\.so/.test(file));
  const dynamic = files
    .filter((file) => /\.so(?:\.|$)/.test(file))
    .map((file) => command('readelf', ['-d', join(dirname(ffmpeg), file)]).toString())
    .join('\n');
  assert.equal(/NEEDED.*libuavs3d\.so/.test(dynamic), bundled.length > 0);
  for (const file of bundled) {
    const path = join(dirname(ffmpeg), file);
    const names = command('nm', ['-D', '--defined-only', path])
      .toString()
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).at(-1));
    assert.equal(names.length, PUBLIC_EXPORTS);
    assert.ok(
      names.every((name) => /^uavs3d_(?:create|delete|reset|flush|decode|img_cpy_cvt)$/.test(name)),
    );
    assert.match(
      command('readelf', ['-d', path]).toString(),
      /SONAME.*libuavs3d\.so\.\d+\.\d+(?:\.\d+)?\]/,
    );
  }
  console.log(
    'AVS3 invalid-input rejection, selected ELF linkage and complete public SDK exports passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
