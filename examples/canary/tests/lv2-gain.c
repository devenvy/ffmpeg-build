/* Owned test plugin using LV2's stable C descriptor ABI. No host-library link.
 * ABI reference: LV2 1.18.10 include/lv2/core/lv2.h, pinned by the canary lock.
 * This fixture checks FFmpeg's advertised features and their NULL terminator.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

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
typedef struct { void *handle; uint32_t (*map)(void *, const char *); } URID_Map;
typedef struct { void *handle; const char *(*unmap)(void *, uint32_t); } URID_Unmap;
static LV2_Handle instantiate(const LV2_Descriptor *descriptor, double rate,
                             const char *path, const LV2_Feature *const *features) {
  (void)descriptor; (void)rate; (void)path;
  static const char *uris[] = {
    "http://lv2plug.in/ns/ext/urid#map",
    "http://lv2plug.in/ns/ext/urid#unmap",
    "http://lv2plug.in/ns/ext/buf-size#powerOf2BlockLength",
    "http://lv2plug.in/ns/ext/buf-size#fixedBlockLength",
    "http://lv2plug.in/ns/ext/buf-size#boundedBlockLength"
  };
  if (!features) return NULL;
  const URID_Map *map = NULL;
  const URID_Unmap *unmap = NULL;
  unsigned seen = 0, count = 0;
  for (; count < 6 && features[count]; count++) {
    const LV2_Feature *feature = features[count];
    if (!feature->URI || !feature->URI[0]) return NULL;
    unsigned index;
    for (index = 0; index < 5; index++) {
      if (!strcmp(feature->URI, uris[index])) break;
    }
    if (index == 5 || (seen & (1u << index))) return NULL;
    seen |= 1u << index;
    if (index == 0) map = feature->data;
    else if (index == 1) unmap = feature->data;
    else if (feature->data) return NULL;
  }
  if (count != 5 || seen != 31 || !map || !unmap || !map->map || !unmap->unmap) return NULL;
  const char *uri = "urn:ffmpeg-build:test:feature-roundtrip";
  uint32_t id = map->map(map->handle, uri);
  const char *resolved = unmap->unmap(unmap->handle, id);
  if (!id || !resolved || strcmp(uri, resolved)) return NULL;
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
