#define _GNU_SOURCE
#include <cpu_features/cpuinfo_x86.h>
#include <ndk_compat/cpu-features.h>
#include <assert.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static void check_provider(int shared) {
  Dl_info native, legacy;
  assert(dladdr((void *)&GetX86Info, &native));
  assert(dladdr((void *)&android_getCpuFeatures, &legacy));
  if (shared) {
    assert(strstr(native.dli_fname, "libcpu_features.so"));
    assert(strstr(legacy.dli_fname, "libndk_compat.so"));
  } else {
    assert(!strstr(native.dli_fname, "libcpu_features.so"));
    assert(!strstr(legacy.dli_fname, "libndk_compat.so"));
  }
}

int main(int argc, char **argv) {
  assert(argc == 3);
  const int shared = strcmp(argv[2], "shared") == 0;
  if (strcmp(argv[1], "setter") == 0) {
    const uint64_t owned_mask = UINT64_C(0x1234);
    /* Native setters must run before any of the one-shot NDK detection queries. */
    assert(android_setCpu(3, owned_mask) == 1);
    assert(android_getCpuCount() == 3);
    assert(android_getCpuFeatures() == owned_mask);
    assert(android_setCpu(2, UINT64_C(0)) == 0);
    assert(android_getCpuCount() == 3 && android_getCpuFeatures() == owned_mask);
    check_provider(shared);
    puts("Android CPU SDK: separate-process one-shot setter/state/provider checks passed");
    return 0;
  }
  assert(strcmp(argv[1], "detect") == 0);
  assert(android_getCpuFamily() == ANDROID_CPU_FAMILY_X86_64);
  assert(android_getCpuCount() >= 1);
  const uint64_t features = android_getCpuFeatures();
  assert(android_getCpuFeatures() == features);
  const X86Info native = GetX86Info();
  assert(native.vendor[0] != '\0' && native.family >= 0 && native.model >= 0);
  const int enum_sse2 = GetX86FeaturesEnumValue(&native.features, X86_SSE2);
  printf("SSE2 enum=%d field=%d\n", enum_sse2, native.features.sse2);
  /* Native signed one-bit fields can promote a true feature to -1. */
  assert(enum_sse2 != 0);
  assert((enum_sse2 != 0) == (native.features.sse2 != 0));
  assert(strcmp(GetX86FeaturesEnumName(X86_SSE2), "sse2") == 0);
  const char *architecture = GetX86MicroarchitectureName(GetX86Microarchitecture(&native));
  assert(architecture && architecture[0]);
  check_provider(shared);
  puts("Android CPU SDK: native x64 detection/feature names, stable NDK queries and selected providers passed");
  return 0;
}
