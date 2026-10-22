#define CL_TARGET_OPENCL_VERSION 300
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <CL/cl.h>

int main(void) {
  cl_uint count = 0;
  assert(clGetPlatformIDs(0, NULL, &count) == CL_SUCCESS && count > 0);
  cl_platform_id *platforms = calloc(count, sizeof(*platforms));
  assert(platforms && clGetPlatformIDs(count, platforms, NULL) == CL_SUCCESS);
  cl_device_id device = NULL;
  for (cl_uint index = 0; index < count && !device; index++) {
    cl_device_id candidate;
    if (clGetDeviceIDs(platforms[index], CL_DEVICE_TYPE_CPU, 1, &candidate, NULL) == CL_SUCCESS) device = candidate;
  }
  free(platforms);
  assert(device);
  cl_device_type type = 0;
  assert(clGetDeviceInfo(device, CL_DEVICE_TYPE, sizeof(type), &type, NULL) == CL_SUCCESS);
  assert(type & CL_DEVICE_TYPE_CPU);
  cl_int error;
  cl_context context = clCreateContext(NULL, 1, &device, NULL, NULL, &error);
  assert(context && error == CL_SUCCESS);
  cl_command_queue queue = clCreateCommandQueueWithProperties(context, device, NULL, &error);
  assert(queue && error == CL_SUCCESS);
  cl_int input[64], output[64];
  for (unsigned index = 0; index < 64; index++) input[index] = (cl_int)index - 31;
  cl_mem source_buffer = clCreateBuffer(context, CL_MEM_READ_ONLY | CL_MEM_COPY_HOST_PTR, sizeof(input), input, &error);
  assert(source_buffer && error == CL_SUCCESS);
  cl_mem target_buffer = clCreateBuffer(context, CL_MEM_WRITE_ONLY, sizeof(output), NULL, &error);
  assert(target_buffer && error == CL_SUCCESS);
  const char *source = "__kernel void owned(__global const int *input, __global int *output) { size_t i = get_global_id(0); output[i] = input[i] * 3 + 7; }";
  cl_program program = clCreateProgramWithSource(context, 1, &source, NULL, &error);
  assert(program && error == CL_SUCCESS);
  assert(clBuildProgram(program, 1, &device, "", NULL, NULL) == CL_SUCCESS);
  cl_kernel kernel = clCreateKernel(program, "owned", &error);
  assert(kernel && error == CL_SUCCESS);
  assert(clSetKernelArg(kernel, 0, sizeof(source_buffer), &source_buffer) == CL_SUCCESS);
  assert(clSetKernelArg(kernel, 1, sizeof(target_buffer), &target_buffer) == CL_SUCCESS);
  const size_t size = 64;
  cl_event event;
  assert(clEnqueueNDRangeKernel(queue, kernel, 1, NULL, &size, NULL, 0, NULL, &event) == CL_SUCCESS);
  assert(clEnqueueReadBuffer(queue, target_buffer, CL_TRUE, 0, sizeof(output), output, 1, &event, NULL) == CL_SUCCESS);
  assert(clFinish(queue) == CL_SUCCESS);
  cl_int state = -1;
  assert(clGetEventInfo(event, CL_EVENT_COMMAND_EXECUTION_STATUS, sizeof(state), &state, NULL) == CL_SUCCESS && state == CL_COMPLETE);
  for (unsigned index = 0; index < 64; index++) assert(output[index] == input[index] * 3 + 7);
  const char *invalid = "__kernel void broken(__global int *out) { out[0] = missing_symbol; }";
  cl_program broken = clCreateProgramWithSource(context, 1, &invalid, NULL, &error);
  assert(broken && error == CL_SUCCESS);
  assert(clBuildProgram(broken, 1, &device, "", NULL, NULL) == CL_BUILD_PROGRAM_FAILURE);
  size_t length = 0;
  assert(clGetProgramBuildInfo(broken, device, CL_PROGRAM_BUILD_LOG, 0, NULL, &length) == CL_SUCCESS && length > 1);
  char *log = calloc(length, 1);
  assert(log && clGetProgramBuildInfo(broken, device, CL_PROGRAM_BUILD_LOG, length, log, NULL) == CL_SUCCESS);
  assert(strstr(log, "missing_symbol"));
  free(log);
  assert(clReleaseProgram(broken) == CL_SUCCESS);
  assert(clReleaseEvent(event) == CL_SUCCESS);
  assert(clReleaseKernel(kernel) == CL_SUCCESS);
  assert(clReleaseProgram(program) == CL_SUCCESS);
  assert(clReleaseMemObject(target_buffer) == CL_SUCCESS);
  assert(clReleaseMemObject(source_buffer) == CL_SUCCESS);
  assert(clReleaseCommandQueue(queue) == CL_SUCCESS);
  assert(clReleaseContext(context) == CL_SUCCESS);
  puts("OpenCL: actual CPU ICD kernel, exact integer results, events, invalid build diagnostics and complete object cleanup passed");
  return 0;
}
