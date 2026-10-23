import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const TIMEOUT = 30000;
const run = (program, args) => {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const gpu = /\bvulkan\b/.test(run(ffmpeg, ['-hide_banner', '-hwaccels']));
process.env.FFB_WHISPER_CPU = gpu ? '0' : '1';
const directory = dirname(ffmpeg);
if (existsSync(join(directory, 'libwhisper.so.1'))) {
  const libraries = [
    'libwhisper.so.1',
    'libparakeet.so.1',
    'libggml.so.0',
    'libggml-base.so.0',
    'libggml-cpu.so.0',
  ];
  if (gpu) {
    libraries.push('libggml-vulkan.so.0');
  }
  for (const soname of libraries) {
    const library = join(directory, soname);
    assert.ok(existsSync(library), soname);
    const dynamic = run('readelf', ['-d', library]);
    assert.ok(dynamic.includes(`[${soname}]`));
    assert.doesNotMatch(dynamic, /libstdc\+\+\.so/);
  }
}
await import('./vulkan-linkage.mjs');
