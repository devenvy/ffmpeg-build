import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FRAME_COUNT = 3;
const REPETITIONS = 3;
const work = mkdtempSync(join(tmpdir(), 'ffb-tensorflow-'));
const model = join(work, 'relu.pb');
// Locally authored TensorFlow GraphDef: Placeholder x -> ReLU y, shape [1, 2, 2, 3].
// Positive RGB frames pass through unchanged. No pretrained weights or third-party model.
writeFileSync(
  model,
  Buffer.from(readFileSync(new URL('tensorflow-model.base64', import.meta.url), 'utf8'), 'base64'),
);
const run = (filter, earlyCutoff) => {
  const result = spawnSync(
    process.env.FFMPEG,
    [
      '-hide_banner',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=2x2:rate=1${earlyCutoff ? '' : ':duration=3'}`,
      '-vf',
      filter,
      ...(earlyCutoff ? ['-frames:v', String(FRAME_COUNT)] : []),
      '-f',
      'framemd5',
      '-',
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter((line) => line.startsWith('0,'));
};
try {
  for (const earlyCutoff of [false, true]) {
    const expected = run('format=rgb24', earlyCutoff);
    assert.equal(expected.length, FRAME_COUNT);
    for (let attempt = 0; attempt < REPETITIONS; attempt++) {
      const actual = run(
        `format=rgb24,dnn_processing=dnn_backend=tensorflow:model=${model}:input=x:output=y`,
        earlyCutoff,
      );
      assert.deepEqual(actual, expected);
    }
  }
  console.log(
    'Static TensorFlow CPU inference passed natural EOF and repeated early-cutoff cleanup',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
