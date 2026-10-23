#include <cstdint>
#include <cstdio>
#include "hwy/aligned_allocator.h"
#undef HWY_TARGET_INCLUDE
#define HWY_TARGET_INCLUDE "highway-api.cc"
#include "hwy/foreach_target.h"
#include "hwy/highway.h"

HWY_BEFORE_NAMESPACE();
namespace proof {
namespace HWY_NAMESPACE {
void Transform(const float* input, float* output, size_t size) {
  namespace hn = hwy::HWY_NAMESPACE;
  const hn::ScalableTag<float> d;
  const size_t lanes = hn::Lanes(d);
  size_t i = 0;
  for (; i + lanes <= size; i += lanes) {
    hn::StoreU(hn::Add(hn::LoadU(d, input + i), hn::Set(d, 7.0f)), d, output + i);
  }
  for (; i < size; ++i) output[i] = input[i] + 7.0f;
}
}
}
HWY_AFTER_NAMESPACE();

#if HWY_ONCE
namespace proof {
HWY_EXPORT(Transform);
void Run(const float* input, float* output, size_t size) {
  HWY_DYNAMIC_DISPATCH(Transform)(input, output, size);
}
}
int main() {
  constexpr size_t count = 257;
  auto input = hwy::AllocateAligned<float>(count);
  auto output = hwy::AllocateAligned<float>(count);
  if (!input || !output || !hwy::SupportedTargets()) return 1;
  for (size_t i = 0; i < count; ++i) input[i] = static_cast<float>(i);
  proof::Run(input.get(), output.get(), count);
  for (size_t i = 0; i < count; ++i) if (output[i] != input[i] + 7.0f) return 2;
  if (!hwy::GetChosenTarget().IsInitialized()) return 3;
  std::puts("Installed Highway C++ SDK: allocated buffers and dispatched 257 exact vector values passed");
  return 0;
}
#endif
