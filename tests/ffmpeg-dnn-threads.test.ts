import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { fixDnnThreadLifecycle } from '../src/build/ffmpeg-dnn.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
const makeSource = () => {
  const root = mkdtempSync(join(tmpdir(), 'ffb-dnn-'));
  dirs.push(root);
  const dir = join(root, 'libavfilter', 'dnn');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'dnn_backend_common.h'), '    pthread_t thread_id;\n');
  writeFileSync(
    join(dir, 'dnn_backend_common.c'),
    `${'    pthread_join(async_module->thread_id, &status);\n'.repeat(
      2,
    )}        return ret;\n    }\n#else\n    ret = async_module->start_inference(async_module->args);\n`,
  );
  return { root, dir };
};

it('joins only created threads, resets ownership on join, and is idempotent', () => {
  const { root, dir } = makeSource();
  expect(fixDnnThreadLifecycle(root, ['--enable-libonnxruntime'])).toBe(true);
  const source = readFileSync(join(dir, 'dnn_backend_common.c'), 'utf8');
  expect(source.match(/if \(async_module->thread_started\)/g)).toHaveLength(2);
  expect(source.match(/async_module->thread_started = 0;/g)).toHaveLength(2);
  expect(source).toContain('async_module->thread_started = 1;\n#else');
  expect(readFileSync(join(dir, 'dnn_backend_common.h'), 'utf8')).toContain('int thread_started;');
  expect(fixDnnThreadLifecycle(root, ['--enable-libonnxruntime'])).toBe(false);
});

it('does not alter builds without ONNX or an upstream implementation that already tracks threads', () => {
  const { root, dir } = makeSource();
  expect(fixDnnThreadLifecycle(root, [])).toBe(false);
  writeFileSync(join(dir, 'dnn_backend_common.c'), '/* upstream corrected implementation */\n');
  expect(fixDnnThreadLifecycle(root, ['--enable-libonnxruntime'])).toBe(false);
  expect(readFileSync(join(dir, 'dnn_backend_common.h'), 'utf8')).not.toContain('thread_started');
});

it('leaves the remaining file untouched when either DNN source file is absent', () => {
  for (const filename of ['dnn_backend_common.c', 'dnn_backend_common.h']) {
    const { root, dir } = makeSource();
    const remaining = join(
      dir,
      filename.endsWith('.c') ? 'dnn_backend_common.h' : 'dnn_backend_common.c',
    );
    const before = readFileSync(remaining, 'utf8');
    rmSync(join(dir, filename));
    expect(fixDnnThreadLifecycle(root, ['--enable-libonnxruntime'])).toBe(false);
    expect(readFileSync(remaining, 'utf8')).toBe(before);
  }
});
