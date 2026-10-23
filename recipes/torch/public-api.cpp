#include <torch/script.h>
#include <torch/torch.h>
#include <c10/util/Exception.h>
#include <torch/csrc/jit/tensorexpr/ir_printer.h>
#include <torch/csrc/jit/tensorexpr/tensor.h>
#include <cassert>
#include <cstdio>
#include <cstring>
#include <exception>
#include <memory>

static int released;
static int warnings;
class OwnedWarningHandler final : public c10::WarningHandler {
 public:
  void process(const c10::Warning &warning) override {
    assert(warning.msg().find("owned warning") != std::string::npos);
    warnings++;
  }
};

int main(void) {
  torch::set_num_threads(1);
  torch::set_num_interop_threads(1);
  {
    using namespace torch::jit::tensorexpr;
    const ExprPtr expression = ExprHandle(7).node();
    const Tensor tensor = Compute("OwnedTensor", {ExprHandle(1)},
                                  [](const VarHandle &) { return ExprHandle(7); });
    const StmtPtr statement = tensor.stmt();
    assert(std::to_string(expression).find('7') != std::string::npos);
    assert(std::to_string(statement).find("OwnedTensor") != std::string::npos);
    assert(std::to_string(tensor).find("OwnedTensor") != std::string::npos);
  }
  OwnedWarningHandler handler;
  {
    c10::WarningUtils::WarningHandlerGuard guard(&handler);
    TORCH_WARN("owned warning");
  }
  assert(warnings == 1);
  auto *data = new float[4]{-2, 1, -1, 3};
  auto tensor = torch::from_blob(data, {2, 2}, [](void *pointer) {
    assert(released == 0);
    released++;
    delete[] static_cast<float *>(pointer);
  }, torch::TensorOptions().dtype(torch::kFloat32));
  auto retained = tensor.narrow(0, 0, 1);
  auto independent = tensor.clone();
  torch::jit::Module module("OwnedRelu");
  module.define(R"JIT(
def forward(self, x):
    return torch.relu(x)
)JIT");
  auto output = module.forward({tensor}).toTensor();
  const float expected[] = {0, 1, 0, 3};
  assert(output.numel() == 4);
  assert(std::memcmp(output.data_ptr<float>(), expected, sizeof(expected)) == 0);
  tensor = torch::Tensor{};
  assert(released == 0 && retained.data_ptr<float>()[0] == -2);
  retained = torch::Tensor{};
  assert(released == 1);
  assert(independent.data_ptr<float>()[0] == -2);
  bool rejected = false;
  try {
    (void)torch::zeros({-1});
  } catch (const c10::Error &error) {
    const std::exception *base = dynamic_cast<const std::exception *>(&error);
    rejected = base && std::strlen(error.what_without_backtrace()) > 0;
  }
  assert(rejected);
  std::puts("Torch: native CPU tensor/JIT inference, external blob deleter and retained views, cloned ownership, external virtual warning callback and typed c10 exception/RTTI passed");
}
