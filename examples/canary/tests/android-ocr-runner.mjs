import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ARGUMENT_OFFSET = 2;
const [target, dist] = process.argv.slice(ARGUMENT_OFFSET);
assert.match(target, /^android-x64-ocr-(?:(?:8|9)-)?lgplv3$/);
assert.ok(dist);
const checks = dirname(fileURLToPath(import.meta.url));
const REMOTE = '/data/local/tmp/ffb-ocr-sdk';
const TIMEOUT = 180000;
const MAX_OUTPUT = 8388608;
const MODEL_BYTES = 4113088;
const MODEL_SHA256 = '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2';
const IMAGE_SHA256 = '455a1c0dfca94f31d8571127eb909f6794f289583d6808ae3aa8cbf52addca38';
const work = mkdtempSync(join(tmpdir(), 'ffb-android-ocr-'));
const execute = (program, args) => {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${program}: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const adb = (...args) => execute('adb', args);
try {
  const archives = readdirSync(dist).filter((name) => name.endsWith(`-${target}.tar.gz`));
  assert.equal(archives.length, 1, archives.join(','));
  execute('tar', ['-xzf', join(dist, archives[0]), '-C', work]);
  const libraries = join(work, 'lib/x86_64');
  assert.equal(existsSync(join(libraries, 'libcpu_features.so')), false);
  assert.equal(existsSync(join(libraries, 'libndk_compat.so')), false);
  const ndk = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_LATEST_HOME,
    process.env.ANDROID_NDK_ROOT,
    process.env.ANDROID_NDK,
  ].find((path) => path && existsSync(path));
  assert.ok(ndk, 'the emulator runner must supply an Android NDK');
  const prebuilt = join(ndk, 'toolchains/llvm/prebuilt');
  const host = readdirSync(prebuilt).find((name) => name.startsWith('linux-'));
  assert.ok(host);
  const compiler = join(prebuilt, host, 'bin/x86_64-linux-android28-clang');
  const ocrHelper = join(work, 'android-ocr-sdk');
  execute(compiler, [
    join(checks, 'android-ocr-sdk.c'),
    '-I',
    join(work, 'include'),
    '-L',
    libraries,
    `-Wl,-rpath-link,${libraries}`,
    '-lavfilter',
    '-lavutil',
    '-o',
    ocrHelper,
  ]);
  const image = gunzipSync(
    Buffer.from(readFileSync(join(checks, 'ocr-text.pgm.gz.b64'), 'utf8').trim(), 'base64'),
  );
  assert.equal(createHash('sha256').update(image).digest('hex'), IMAGE_SHA256);
  const model = process.env.FFB_OCR_MODEL
    ? readFileSync(process.env.FFB_OCR_MODEL)
    : Buffer.from(
        await (
          await fetch(
            'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/65727574dfcd264acbb0c3e07860e4e9e9b22185/eng.traineddata',
            { signal: AbortSignal.timeout(TIMEOUT) },
          )
        ).arrayBuffer(),
      );
  assert.equal(model.length, MODEL_BYTES);
  assert.equal(createHash('sha256').update(model).digest('hex'), MODEL_SHA256);
  writeFileSync(join(work, 'owned.pgm'), image);
  writeFileSync(join(work, 'eng.traineddata'), model);
  assert.match(adb('devices'), /\tdevice$/m);
  assert.ok(adb('shell', 'getprop', 'ro.product.cpu.abilist').includes('x86_64'));
  adb('shell', `rm -rf ${REMOTE} && mkdir -p ${REMOTE}`);
  for (const name of readdirSync(libraries).filter((entry) => entry.endsWith('.so'))) {
    const copy = join(work, name);
    copyFileSync(join(libraries, name), copy);
    execute('patchelf', ['--set-rpath', REMOTE, copy]);
    adb('push', copy, `${REMOTE}/${name}`);
  }
  for (const [path, name] of [
    [ocrHelper, 'ocr-sdk'],
    [join(work, 'owned.pgm'), 'owned.pgm'],
    [join(work, 'eng.traineddata'), 'eng.traineddata'],
  ]) {
    adb('push', path, `${REMOTE}/${name}`);
  }
  adb('shell', `chmod 755 ${REMOTE}/ocr-sdk`);
  const output = adb(
    'shell',
    `cd ${REMOTE} && LD_LIBRARY_PATH=${REMOTE} ./ocr-sdk ${REMOTE}/owned.pgm ${REMOTE}`,
  );
  assert.match(output, /Android FFmpeg SDK: .* passed/);
  console.log(output.trim());
} finally {
  spawnSync('adb', ['shell', `rm -rf ${REMOTE}`], { timeout: TIMEOUT, killSignal: 'SIGKILL' });
  rmSync(work, { recursive: true, force: true });
}
