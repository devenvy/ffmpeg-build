#include <dc1394/dc1394.h>
#include <stdio.h>
#include <string.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "FireWire SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
static int dc_sdk(void) {
  uint32_t bits = 0;
  CHECK(dc1394_get_color_coding_bit_size(DC1394_COLOR_CODING_MONO8, &bits) == DC1394_SUCCESS && bits == 8);
  CHECK(dc1394_error_get_string(DC1394_SUCCESS));
  uint8_t mono[16], rgb[48];
  for (unsigned index = 0; index < 16; index++) mono[index] = index * 13;
  memset(rgb, 0, sizeof(rgb));
  CHECK(dc1394_convert_to_RGB8(mono, rgb, 4, 4, DC1394_BYTE_ORDER_UYVY, DC1394_COLOR_CODING_MONO8, 8) == DC1394_SUCCESS);
  for (unsigned index = 0; index < 16; index++)
    for (unsigned channel = 0; channel < 3; channel++) CHECK(rgb[index * 3 + channel] == mono[index]);
  dc1394_t *context = dc1394_new();
  if (!context) {
    puts("DC1394: exact owned MONO8/RGB pixels passed; unavailable controller backend returned NULL cleanly; camera enumeration untested");
    return 0;
  }
  dc1394camera_list_t *cameras = NULL;
  CHECK(dc1394_camera_enumerate(context, &cameras) == DC1394_SUCCESS && cameras);
  printf("DC1394: owned exact MONO8/RGB pixels, context lifecycle, camera enumeration (%u found); no camera operation claimed\n", cameras->num);
  dc1394_camera_free_list(cameras);
  dc1394_free(context);
  return 0;
}

int main(void) { return dc_sdk(); }
