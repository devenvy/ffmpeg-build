import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ffmpeg = process.env.FFMPEG;
const model = process.env.FFB_OCR_MODEL;
assert.ok(ffmpeg && model);
const TIMEOUT = 120000;
const MAX_OUTPUT = 8388608;
const MODEL_BYTES = 4113088;
const MODEL_SHA256 = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2';
const IMAGE_SHA256 = '455a1c0dfca94f31d8571127eb909f6794f289583d6808ae3aa8cbf52addca38';
const WIDTH = 1100;
const HEIGHT = 180;
const checks = dirname(fileURLToPath(import.meta.url));
const image = gunzipSync(
  Buffer.from(readFileSync(join(checks, 'ocr-text.pgm.gz.b64'), 'utf8').trim(), 'base64'),
);
assert.equal(createHash('sha256').update(image).digest('hex'), IMAGE_SHA256);
const modelBytes = readFileSync(model);
assert.equal(modelBytes.length, MODEL_BYTES);
assert.equal(createHash('sha256').update(modelBytes).digest('hex'), MODEL_SHA256);
const execute = (program, args) =>
  spawnSync(program, args, {
    env: { ...process.env, LD_BIND_NOW: '1' },
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
const run = (args) => execute(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args]);
const work = mkdtempSync(join(tmpdir(), 'ffb-ocr-'));
try {
  const input = join(work, 'owned-text.pgm');
  const metadata = join(work, 'metadata.txt');
  writeFileSync(input, image);
  const result = run([
    '-i',
    input,
    '-vf',
    `ocr=datapath=${dirname(model)}:language=eng,metadata=mode=print:file=${metadata}`,
    '-frames:v',
    '1',
    '-pix_fmt',
    'gray',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr.toString());
  assert.equal(result.stdout.length, WIDTH * HEIGHT);
  const text = readFileSync(metadata, 'utf8');
  assert.match(text, /lavfi\.ocr\.text=HELLO WORLD 123/);
  const missing = run([
    '-i',
    input,
    '-vf',
    `ocr=datapath=${work}:language=ffb_missing_language`,
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ]);
  assert.equal(missing.signal, null, missing.error?.message);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr.toString(), /traineddata|language|tesseract/i);
  for (const name of ['libleptonica.so.6', 'libtesseract.so.5.5']) {
    const library = join(dirname(ffmpeg), name);
    if (existsSync(library)) {
      const dynamic = execute('readelf', ['-d', library]);
      assert.equal(dynamic.status, 0);
      assert.ok(dynamic.stdout.toString().includes(`[${name}]`));
      assert.doesNotMatch(dynamic.stdout.toString(), /libstdc\+\+\.so/);
    }
  }
  console.log(
    'OCR: owned HELLO WORLD 123 recognition, exact frame dimensions, missing model rejection and native shared ABI passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
