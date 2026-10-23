#include <openvino/c/openvino.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>

static void check(ov_status_e status) {
  if (status != OK) fprintf(stderr, "OpenVINO status %d: %s\n", status, ov_get_error_info(status));
  assert(status == OK);
}

int main(int argc, char **argv) {
  assert(argc == 2);
  ov_core_t *core = NULL;
  ov_model_t *model = NULL;
  ov_compiled_model_t *compiled = NULL;
  ov_infer_request_t *request = NULL;
  ov_tensor_t *input = NULL, *output = NULL;
  check(ov_core_create(&core));
  ov_available_devices_t devices = {0};
  check(ov_core_get_available_devices(core, &devices));
  int cpu_found = 0;
  for (size_t index = 0; index < devices.size; index++) {
    if (strcmp(devices.devices[index], "CPU") == 0) cpu_found = 1;
  }
  assert(cpu_found);
  ov_available_devices_free(&devices);
  check(ov_core_read_model(core, argv[1], NULL, &model));
  check(ov_core_compile_model(core, model, "CPU", 0, &compiled));
  check(ov_compiled_model_create_infer_request(compiled, &request));
  const int64_t dimensions[] = {1, 3, 2, 2};
  ov_shape_t shape = {0};
  check(ov_shape_create(4, dimensions, &shape));
  float values[12], expected[12];
  for (int index = 0; index < 12; index++) {
    values[index] = (float)index - 6;
    expected[index] = values[index] < 0 ? 0 : values[index];
  }
  check(ov_tensor_create_from_host_ptr(F32, shape, values, &input));
  ov_shape_free(&shape);
  check(ov_infer_request_set_input_tensor(request, input));
  ov_tensor_free(input);
  ov_compiled_model_free(compiled);
  ov_model_free(model);
  ov_core_free(core);
  check(ov_infer_request_infer(request));
  check(ov_infer_request_get_output_tensor(request, &output));
  ov_infer_request_free(request);
  size_t count = 0;
  check(ov_tensor_get_size(output, &count));
  assert(count == 12);
  void *actual = NULL;
  check(ov_tensor_data(output, &actual));
  assert(memcmp(actual, expected, sizeof(expected)) == 0);
  ov_tensor_free(output);
  assert(ov_core_get_available_devices(NULL, &devices) == INVALID_C_PARAM);
  puts("OpenVINO: native relocated CPU discovery, IR loading/ReLU inference, caller-owned tensor and request/output retention after parent destruction passed");
  return 0;
}
