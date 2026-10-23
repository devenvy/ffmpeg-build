import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const runtime = dirname(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-onnx-linkage-'));
const FRAME_COUNT = 3;
const TIMEOUT = 120000;
const MAX_OUTPUT = 4194304;
const MODEL =
  '08083a560a100a017812017922084964656e7469747912086964656e746974795a1b0a017812160a14080112100a0208010a0208030a0208020a020802621b0a017912160a14080112100a0208010a0208030a0208020a0208024202100d';
const environment = {
  ...process.env,
  OMP_NUM_THREADS: '1',
  TF_NUM_INTRAOP_THREADS: '1',
  TF_NUM_INTEROP_THREADS: '1',
};

function command(program, args) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
    env: environment,
  });
  assert.equal(result.status, 0, `${program}: ${result.stderr}`);
  return result.stdout;
}

function frames(filter, reject = false) {
  const result = spawnSync(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-filter_threads',
      '1',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=2x2:rate=1:duration=${FRAME_COUNT}`,
      '-vf',
      filter,
      '-f',
      'framemd5',
      '-',
    ],
    {
      encoding: 'utf8',
      timeout: TIMEOUT,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_OUTPUT,
      env: environment,
    },
  );
  assert.equal(result.signal, null, result.stderr);
  if (reject) {
    assert.notEqual(result.status, 0, 'Invalid ONNX model must be rejected cleanly');
    return [];
  }
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split('\n').filter((line) => line.startsWith('0,'));
  assert.equal(
    lines.length,
    FRAME_COUNT,
    'Every authored input frame must drain through natural EOF',
  );
  return lines;
}

try {
  const model = join(work, 'identity.onnx');
  writeFileSync(model, Buffer.from(MODEL, 'hex'));
  const onnx = `dnn_processing=dnn_backend=onnx:model=${model}:input=x:output=y`;
  const expected = frames('format=rgb24');
  assert.deepEqual(frames(`format=rgb24,${onnx}`), expected);
  frames(
    `format=rgb24,dnn_processing=dnn_backend=onnx:model=${join(work, 'missing.onnx')}:input=x:output=y`,
    true,
  );
  const configuration = command(ffmpeg, ['-hide_banner', '-buildconf']);
  if (
    ['libtensorflow', 'libopenvino', 'libtorch'].every((name) =>
      configuration.includes(`--enable-${name}`),
    )
  ) {
    const tensorflow = join(work, 'relu.pb');
    const torch = join(work, 'relu.pt');
    writeFileSync(
      tensorflow,
      Buffer.from(
        readFileSync(new URL('tensorflow-model.base64', import.meta.url), 'utf8'),
        'base64',
      ),
    );
    writeFileSync(
      torch,
      Buffer.from(readFileSync(new URL('torch-model.base64', import.meta.url), 'utf8'), 'base64'),
    );
    const openvino = fileURLToPath(new URL('openvino.xml', import.meta.url));
    const chain = [
      'format=rgb24',
      onnx,
      `dnn_processing=dnn_backend=tensorflow:model=${tensorflow}:input=x:output=y`,
      `dnn_processing=dnn_backend=torch:model=${torch}`,
      `dnn_processing=dnn_backend=openvino:model=${openvino}:input=x:output=relu:options=layout=nchw`,
    ].join(',');
    assert.deepEqual(frames(chain), expected);
    console.log(
      'Four-backend ONNX/TensorFlow/Torch/OpenVINO chain preserved all authored frames through natural EOF',
    );
  }
  const shared = existsSync(join(runtime, 'libonnxruntime.so.1'));
  const filter = readdirSync(runtime).find((name) => /^libavfilter\.so\.\d+$/.test(name));
  assert.ok(filter);
  assert.equal(
    /NEEDED.*libonnxruntime\.so\.1/.test(command('readelf', ['-d', join(runtime, filter)])),
    shared,
  );
  if (shared) {
    for (const name of ['libonnxruntime.so.1', 'libonnxruntime_providers_shared.so']) {
      const path = join(runtime, name);
      const dynamic = command('readelf', ['-d', path]);
      assert.doesNotMatch(dynamic, /NEEDED.*libstdc\+\+/);
      if (name === 'libonnxruntime.so.1') {
        assert.match(dynamic, /SONAME.*\[libonnxruntime\.so\.1\]/);
      }
      const symbols = command('nm', ['-D', '--defined-only', path]);
      assert.doesNotMatch(
        symbols,
        /\b(?:_ZSt|_ZNSt|_ZNKSt|_ZN6google|_ZNK6google|__cxa|_Unwind)\w*/,
      );
    }
  }
  console.log(
    `ONNX ${shared ? 'shared' : 'static'}: exact inference/EOF, invalid-model cleanup and packaged native runtime/provider ownership passed`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
