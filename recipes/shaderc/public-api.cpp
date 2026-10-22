#include <cassert>
#include <cstdint>
#include <vector>
#include <shaderc/shaderc.hpp>

int main() {
  shaderc::Compiler compiler;
  shaderc::CompileOptions options;
  options.SetTargetEnvironment(shaderc_target_env_vulkan, shaderc_env_version_vulkan_1_2);
  auto result = compiler.CompileGlslToSpv(
      "#version 450\nlayout(local_size_x=1) in; void main() {}\n",
      shaderc_compute_shader, "owned.comp", options);
  assert(result.GetCompilationStatus() == shaderc_compilation_status_success);
  std::vector<uint32_t> owned(result.cbegin(), result.cend());
  assert(!owned.empty() && owned.front() == UINT32_C(0x07230203));
  auto invalid = compiler.CompileGlslToSpv("invalid GLSL", shaderc_compute_shader, "invalid.comp");
  assert(invalid.GetCompilationStatus() != shaderc_compilation_status_success);
  assert(!invalid.GetErrorMessage().empty());
}
