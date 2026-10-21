import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixTorchBackend } from '../src/build/ffmpeg-torch.ts';

const CONFIGURE =
  'enabled libtorch          && check_cxxflags -std=c++17 && require_cxx libtorch torch/torch.h "torch::Tensor" -ltorch -lc10 -ltorch_cpu -lstdc++ -lpthread\n';
const BACKEND =
  '    th_model->ctx = ctx;\n    c10::Device device = (*th_model->jit_model->parameters().begin()).device();\n';

describe('FFmpeg Torch compatibility', () => {
  it('uses the complete static link closure, supports parameterless models and waits for its one request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffb-torch-fix-'));
    const backend = join(dir, 'libavfilter', 'dnn', 'dnn_backend_torch.cpp');
    try {
      mkdirSync(join(dir, 'libavfilter', 'dnn'), { recursive: true });
      writeFileSync(join(dir, 'configure'), CONFIGURE);
      writeFileSync(backend, BACKEND);
      expect(fixTorchBackend(dir, ['--enable-libtorch'])).toBe(true);
      const configure = readFileSync(join(dir, 'configure'), 'utf8');
      const patched = readFileSync(backend, 'utf8');
      expect(configure).toContain('check_cxxflags -std=c++20');
      expect(configure).toContain('require_pkg_config_cxx libtorch torch');
      expect(patched).toContain('ctx->nireq = 1;');
      expect(patched).toContain('c10::Device device(ctx->device ? ctx->device : "cpu");');
      expect(patched).not.toContain('parameters().begin()');
      expect(fixTorchBackend(dir, ['--enable-libtorch'])).toBe(false);
      expect(readFileSync(backend, 'utf8')).toBe(patched);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves builds without Torch unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffb-torch-off-'));
    try {
      writeFileSync(join(dir, 'configure'), CONFIGURE);
      expect(fixTorchBackend(dir, [])).toBe(false);
      expect(readFileSync(join(dir, 'configure'), 'utf8')).toBe(CONFIGURE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
