import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FRAME_COUNT = 3;
const REPETITIONS = 3;
const work = mkdtempSync(join(tmpdir(), 'ffb-torch-'));
const model = join(work, 'relu.pt');
// Owned TorchScript module: forward(x) returns torch.relu(x), with one CPU parameter
// for stock FFmpeg's device discovery. Regenerate with generate-torch-model.py.
// Positive RGB frames pass through unchanged. No pretrained weights or third-party model.
writeFileSync(
  model,
  Buffer.from(readFileSync(new URL('torch-model.base64', import.meta.url), 'utf8'), 'base64'),
);
const run = (filter, earlyCutoff, reject = false) => {
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
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  if (reject) {
    assert.notEqual(result.status, 0, 'An invalid Torch model must fail cleanly');
    return [];
  }
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter((line) => line.startsWith('0,'));
};
try {
  for (const earlyCutoff of [false, true]) {
    const expected = run('format=rgb24', earlyCutoff);
    assert.equal(expected.length, FRAME_COUNT);
    for (let attempt = 0; attempt < REPETITIONS; attempt++) {
      const actual = run(
        `format=rgb24,dnn_processing=dnn_backend=torch:model=${model}`,
        earlyCutoff,
      );
      assert.deepEqual(actual, expected);
    }
  }
  assert.deepEqual(
    run(`format=rgb24,trim=end_frame=0,dnn_processing=dnn_backend=torch:model=${model}`, false),
    [],
  );
  const invalid = join(work, 'invalid.pt');
  writeFileSync(invalid, 'owned invalid Torch model');
  run(`format=rgb24,dnn_processing=dnn_backend=torch:model=${invalid}`, false, true);
  console.log(
    'Torch CPU inference passed natural EOF, early cutoff, empty-input and invalid-model cleanup',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
