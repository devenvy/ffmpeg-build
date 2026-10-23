#include <openvino/core/type.hpp>
#include <openvino/core/type/float16.hpp>
#include <cassert>
#include <cstdio>
#include <functional>

int main(void) {
  const ov::DiscreteTypeInfo owned("OwnedNode", "opset1");
  assert(std::hash<ov::DiscreteTypeInfo>{}(owned) == owned.hash());
  const ov::float16 finite(1.0f);
  const ov::float16 nan = ov::float16::from_bits(0x7e00);
  assert(!std::isnan(finite) && std::isnan(nan));
  std::puts("OpenVINO: both explicitly public std type bridges remain callable across the native root boundary");
}
