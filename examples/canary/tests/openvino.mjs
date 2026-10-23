import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FRAME_COUNT = 3;
const model = fileURLToPath(new URL('openvino.xml', import.meta.url));
const run = (filter) => {
  const result = spawnSync(
    process.env.FFMPEG,
    [
      '-hide_banner',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=2x2:rate=1:duration=3',
      '-vf',
      filter,
      '-f',
      'framemd5',
      '-',
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter((line) => line.startsWith('0,'));
};
// ReLU is an identity for the nonnegative RGB values. This runs the actual
// CPU plugin repeatedly and checks every output frame against the unfiltered input.
const expected = run('format=rgb24');
const actual = run(
  `format=rgb24,dnn_processing=dnn_backend=openvino:model=${model}:input=x:output=relu:options=layout=nchw`,
);
assert.equal(actual.length, FRAME_COUNT);
assert.deepEqual(actual, expected);
console.log('OpenVINO CPU inference preserved all three RGB test frames through natural EOF');
