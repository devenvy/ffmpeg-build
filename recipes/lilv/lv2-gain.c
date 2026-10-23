/* Owned test plugin using LV2's stable C descriptor ABI. No host-library link.
 * ABI reference: LV2 1.18.10 include/lv2/core/lv2.h, pinned by the canary lock.
 * This plugin requires no host features and deliberately does not inspect them.
 */
#include <stdint.h>
#include <stdlib.h>

typedef void *LV2_Handle;
typedef struct { const char *URI; void *data; } LV2_Feature;
typedef struct LV2_Descriptor LV2_Descriptor;
struct LV2_Descriptor {
  const char *URI;
  LV2_Handle (*instantiate)(const LV2_Descriptor *, double, const char *, const LV2_Feature *const *);
  void (*connect_port)(LV2_Handle, uint32_t, void *);
  void (*activate)(LV2_Handle);
  void (*run)(LV2_Handle, uint32_t);
  void (*deactivate)(LV2_Handle);
  void (*cleanup)(LV2_Handle);
  const void *(*extension_data)(const char *);
};
typedef struct { const float *input; float *output; const float *gain; } Gain;
static LV2_Handle instantiate(const LV2_Descriptor *descriptor, double rate,
                             const char *path, const LV2_Feature *const *features) {
  (void)descriptor; (void)rate; (void)path; (void)features;
  return calloc(1, sizeof(Gain));
}
static void connect_port(LV2_Handle instance, uint32_t port, void *data) {
  Gain *gain = instance;
  if (port == 0) gain->input = data;
  else if (port == 1) gain->output = data;
  else if (port == 2) gain->gain = data;
}
static void run(LV2_Handle instance, uint32_t count) {
  Gain *gain = instance;
  if (!gain->output) return;
  const float scale = gain->gain ? *gain->gain : 1;
  for (uint32_t index = 0; index < count; index++)
    gain->output[index] = gain->input ? gain->input[index] * scale : 0;
}
static void cleanup(LV2_Handle instance) { free(instance); }
static const LV2_Descriptor descriptor = {
  "urn:ffmpeg-build:test:gain", instantiate, connect_port, NULL, run, NULL, cleanup, NULL
};
__attribute__((visibility("default")))
const LV2_Descriptor *lv2_descriptor(uint32_t index) { return index == 0 ? &descriptor : NULL; }
