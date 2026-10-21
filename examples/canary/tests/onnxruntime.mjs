import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Self-generated ONNX IR8/opset13 Identity graph: float32 x -> y, shape [1, 3, 2, 2].
const MODEL =
  '08083a560a100a017812017922084964656e7469747912086964656e746974795a1b0a017812160a14080112100a0208010a0208030a0208020a020802621b0a017912160a14080112100a0208010a0208030a0208020a0208024202100d';
const FRAME_COUNT = 3;
const dir = mkdtempSync(join(tmpdir(), 'ffb-onnx-'));
const model = join(dir, 'identity.onnx');
try {
  writeFileSync(model, Buffer.from(MODEL, 'hex'));
  const run = (filter) => {
    const result = spawnSync(
      process.env.FFMPEG,
      [
        '-hide_banner',
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=2x2:rate=1',
        '-vf',
        filter,
        '-frames:v',
        String(FRAME_COUNT),
        '-f',
        'framemd5',
        '-',
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.split('\n').filter((line) => line.startsWith('0,'));
  };
  const expected = run('format=rgb24');
  const actual = run(
    `format=rgb24,dnn_processing=dnn_backend=onnx:model=${model}:input=x:output=y`,
  );
  assert.equal(actual.length, FRAME_COUNT);
  assert.deepEqual(actual, expected);
  console.log('ONNX Runtime CPU inference preserved all three test frames');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
