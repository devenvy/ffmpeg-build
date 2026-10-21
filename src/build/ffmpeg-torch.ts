import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OLD_PROBE =
  'enabled libtorch          && check_cxxflags -std=c++17 && require_cxx libtorch torch/torch.h "torch::Tensor" -ltorch -lc10 -ltorch_cpu -lstdc++ -lpthread';
const PROBE =
  'enabled libtorch          && check_cxxflags -std=c++20 && require_pkg_config_cxx libtorch torch torch/torch.h "torch::Tensor"';

/** Modern static Torch needs its full CMake closure and C++20; FFmpeg must also wait for its one request. */
export function fixTorchBackend(dir: string, flags: readonly string[]): boolean {
  if (!flags.includes('--enable-libtorch')) {
    return false;
  }
  let changed = false;
  const configure = join(dir, 'configure');
  const original = readFileSync(configure, 'utf8');
  if (original.includes(OLD_PROBE)) {
    writeFileSync(configure, original.replace(OLD_PROBE, PROBE));
    changed = true;
  }
  const backend = join(dir, 'libavfilter', 'dnn', 'dnn_backend_torch.cpp');
  if (!existsSync(backend)) {
    return changed;
  }
  const source = readFileSync(backend, 'utf8');
  let patched = source.replace(
    'c10::Device device = (*th_model->jit_model->parameters().begin()).device();',
    'c10::Device device(ctx->device ? ctx->device : "cpu");',
  );
  if (!patched.includes('ctx->nireq = 1;')) {
    patched = patched.replace(
      '    th_model->ctx = ctx;\n',
      '    th_model->ctx = ctx;\n    ctx->nireq = 1; // This backend allocates one request.\n',
    );
  }
  if (patched !== source) {
    writeFileSync(backend, patched);
    changed = true;
  }
  return changed;
}
