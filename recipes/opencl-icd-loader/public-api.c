#define CL_TARGET_OPENCL_VERSION 300
#include <assert.h>
#include <CL/cl.h>
#include <CL/cl_ext.h>

int main(void) {
  cl_uint count = 999;
  cl_int status = clGetPlatformIDs(0, NULL, &count);
  assert(status == CL_PLATFORM_NOT_FOUND_KHR && count == 0);
  assert(clGetPlatformInfo(NULL, CL_PLATFORM_NAME, 0, NULL, NULL) == CL_INVALID_PLATFORM);
  return 0;
}
