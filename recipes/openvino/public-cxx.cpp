#include <openvino/openvino.hpp>
#include <algorithm>
#include <cassert>
#include <cstdio>

int main(int argc, char **argv) {
    assert(argc == 2);
    ov::Core core;
    const auto model = core.read_model(argv[1]);
    auto compiled = core.compile_model(model, "CPU");
    auto request = compiled.create_infer_request();
    auto input = request.get_input_tensor();
    assert(input.get_element_type() == ov::element::f32 && input.get_size() == 12);
    for (size_t index = 0; index < input.get_size(); ++index)
        input.data<float>()[index] = static_cast<float>(static_cast<int>(index % 5) - 2);
    request.infer();
    const auto output = request.get_output_tensor();
    assert(output.get_size() == input.get_size());
    for (size_t index = 0; index < output.get_size(); ++index) {
        const float expected = std::max(0.0f, static_cast<float>(static_cast<int>(index % 5) - 2));
        assert(output.data<float>()[index] == expected);
    }
    std::puts("OpenVINO: installed C++ SDK, native CPU/IR discovery and exact owned inference passed");
    return 0;
}
