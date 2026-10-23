#include <libraw1394/raw1394.h>
#include <libavc1394/avc1394_vcr.h>
#include <libavc1394/rom1394.h>
#include <stdio.h>
#include <string.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "FireWire SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
static int avc_sdk(void) {
  const char *status = avc1394_vcr_decode_status(0);
  CHECK(status && strcmp(status, "OK") == 0);
  rom1394_directory directory = {0};
  CHECK(rom1394_get_node_type(&directory) == ROM1394_NODE_TYPE_UNKNOWN);
  directory.unit_spec_id = 0xA02D;
  directory.unit_sw_version = 0x100;
  CHECK(rom1394_get_node_type(&directory) == ROM1394_NODE_TYPE_DC);
  directory.unit_sw_version = 0x010000;
  CHECK(rom1394_get_node_type(&directory) == ROM1394_NODE_TYPE_AVC);
  directory.unit_spec_id = 0x609E;
  directory.unit_sw_version = 0x10483;
  CHECK(rom1394_get_node_type(&directory) == ROM1394_NODE_TYPE_SBP2);
  rom1394_free_directory(&directory);
  puts("AVC/ROM1394: authored status and unknown/DC/AVC/SBP2 ROM directory classification passed");
  return 0;
}

int main(void) { return avc_sdk(); }
