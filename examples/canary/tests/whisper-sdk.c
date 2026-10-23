#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <whisper.h>
#include <parakeet.h>
#include <ggml.h>
#include <ggml-alloc.h>
#include <ggml-backend.h>
#include <ggml-cpu.h>
#include <gguf.h>

static void tensor_compute(void) {
  enum { COUNT = 32 };
  ggml_backend_t backend = ggml_backend_cpu_init();
  assert(backend && ggml_backend_reg_count() > 0);
  struct ggml_init_params params = {
    .mem_size = ggml_tensor_overhead() * 4 + ggml_graph_overhead(),
    .mem_buffer = NULL,
    .no_alloc = true,
  };
  struct ggml_context *ctx = ggml_init(params);
  assert(ctx);
  struct ggml_tensor *a = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, COUNT);
  struct ggml_tensor *b = ggml_new_tensor_1d(ctx, GGML_TYPE_F32, COUNT);
  struct ggml_tensor *sum = ggml_add(ctx, a, b);
  struct ggml_cgraph *graph = ggml_new_graph(ctx);
  ggml_build_forward_expand(graph, sum);
  ggml_backend_buffer_t buffer = ggml_backend_alloc_ctx_tensors(ctx, backend);
  assert(buffer);
  float input_a[COUNT], input_b[COUNT], output[COUNT];
  for (int index = 0; index < COUNT; index++) {
    input_a[index] = (float)index;
    input_b[index] = (float)(3 * index + 7);
  }
  ggml_backend_tensor_set(a, input_a, 0, sizeof(input_a));
  ggml_backend_tensor_set(b, input_b, 0, sizeof(input_b));
  assert(ggml_backend_graph_compute(backend, graph) == GGML_STATUS_SUCCESS);
  ggml_backend_tensor_get(sum, output, 0, sizeof(output));
  for (int index = 0; index < COUNT; index++) assert(output[index] == input_a[index] + input_b[index]);
  ggml_backend_buffer_free(buffer);
  ggml_free(ctx);
  ggml_backend_free(backend);
}
static void metadata(void) {
  struct gguf_context *ctx = gguf_init_empty();
  assert(ctx);
  gguf_set_val_str(ctx, "ffmpeg-build.owned", "public GGUF SDK");
  size_t bytes = gguf_get_meta_size(ctx);
  assert(bytes > 0);
  void *data = malloc(bytes);
  assert(data);
  gguf_get_meta_data(ctx, data);
  struct gguf_init_params params = {.no_alloc = true, .ctx = NULL};
  struct gguf_context *read = gguf_init_from_buffer(data, bytes, params);
  assert(read);
  int64_t key = gguf_find_key(read, "ffmpeg-build.owned");
  assert(key >= 0 && !strcmp(gguf_get_val_str(read, key), "public GGUF SDK"));
  assert(gguf_find_key(read, "missing") == -1);
  gguf_free(read);
  gguf_free(ctx);
  free(data);
}
int main(void) {
  struct whisper_context_params *whisper_params = whisper_context_default_params_by_ref();
  assert(whisper_params);
  whisper_params->use_gpu = false;
  unsigned char invalid[8] = {0};
  assert(!whisper_init_from_buffer_with_params(invalid, sizeof(invalid), *whisper_params));
  whisper_free_context_params(whisper_params);
  struct parakeet_context_params *parakeet_params = parakeet_context_default_params_by_ref();
  assert(parakeet_params);
  parakeet_params->use_gpu = false;
  assert(!parakeet_init_from_buffer_with_params(invalid, sizeof(invalid), *parakeet_params));
  parakeet_free_context_params(parakeet_params);
  tensor_compute();
  metadata();
  puts("Whisper/Parakeet invalid-model cleanup, actual GGML CPU graph/allocation/readback and GGUF metadata round trip passed");
  return 0;
}
