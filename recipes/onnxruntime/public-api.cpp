#include <onnxruntime_cxx_api.h>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <fstream>
#include <iterator>
#include <vector>

static OrtMemoryInfo *allocation_info;
static void *owned_buffer;
static int freed;
static void *ORT_API_CALL allocate(OrtAllocator *, size_t size) { return std::malloc(size); }
static void ORT_API_CALL release(OrtAllocator *, void *pointer) {
  assert(pointer == owned_buffer && freed == 0);
  freed++;
  std::free(pointer);
}
static const OrtMemoryInfo *ORT_API_CALL info(const OrtAllocator *) { return allocation_info; }

int main(int argc, char **argv) {
  assert(argc == 3);
  std::ifstream file(argv[1], std::ios::binary);
  const std::vector<char> model((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  assert(!model.empty());
  const OrtApi *api = OrtGetApiBase()->GetApi(ORT_API_VERSION);
  assert(api && OrtGetApiBase()->GetApi(0) == nullptr);
  Ort::Env environment(ORT_LOGGING_LEVEL_WARNING, "owned-onnx-sdk");
  Ort::SessionOptions options;
  options.SetIntraOpNumThreads(1);
  options.SetInterOpNumThreads(1);
  Ort::Session session(environment, model.data(), model.size(), options);
  assert(session.GetInputCount() == 1 && session.GetOutputCount() == 1);
  Ort::AllocatorWithDefaultOptions allocator;
  auto input_name = session.GetInputNameAllocated(0, allocator);
  auto output_name = session.GetOutputNameAllocated(0, allocator);
  assert(std::strcmp(input_name.get(), "x") == 0 && std::strcmp(output_name.get(), "y") == 0);
  auto memory = Ort::MemoryInfo::CreateCpu(OrtDeviceAllocator, OrtMemTypeDefault);
  allocation_info = memory;
  OrtAllocator deleter{};
  deleter.version = ORT_API_VERSION;
  deleter.Alloc = allocate;
  deleter.Free = release;
  deleter.Info = info;
  const int64_t shape[] = {1, 3, 2, 2};
  float expected[12];
  for (int index = 0; index < 12; index++) expected[index] = (float)index / 12.0f;
  owned_buffer = std::malloc(sizeof(expected));
  assert(owned_buffer);
  std::memcpy(owned_buffer, expected, sizeof(expected));
  OrtValue *raw = nullptr;
  Ort::ThrowOnError(api->CreateTensorWithDataAndDeleterAsOrtValue(&deleter, owned_buffer, sizeof(expected),
                   shape, 4, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, &raw));
  Ort::Value input(raw);
  const char *inputs[] = {input_name.get()}, *outputs[] = {output_name.get()};
  auto results = session.Run(Ort::RunOptions{nullptr}, inputs, &input, 1, outputs, 1);
  assert(results.size() == 1 && results[0].IsTensor());
  assert(std::memcmp(results[0].GetTensorData<float>(), expected, sizeof(expected)) == 0);
  input = Ort::Value{nullptr};
  assert(std::memcmp(results[0].GetTensorData<float>(), expected, sizeof(expected)) == 0);
  results.clear();
  assert(freed == 1);
  bool rejected = false;
  try {
    const char invalid[] = "owned invalid model";
    Ort::Session bad(environment, invalid, sizeof(invalid), options);
  } catch (const Ort::Exception &error) {
    rejected = error.GetOrtErrorCode() != ORT_OK && std::strlen(error.what()) > 0;
  }
  assert(rejected);
  void *bridge = dlopen(argv[2], RTLD_NOW | RTLD_LOCAL);
  assert(bridge);
  using Getter = void *(*)();
  using Setter = void (*)(void *);
  auto get_host = reinterpret_cast<Getter>(dlsym(bridge, "Provider_GetHost"));
  auto set_host = reinterpret_cast<Setter>(dlsym(bridge, "Provider_SetHost"));
  assert(get_host && set_host);
  void *original = get_host();
  set_host(nullptr);
  assert(get_host() == nullptr);
  set_host(original);
  assert(dlclose(bridge) == 0);
  std::puts("ONNX Runtime: native C/C++ CPU inference, external tensor deleter/retention, allocated names, typed errors and provider bridge lifecycle passed");
}
