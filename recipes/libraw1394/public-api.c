#include <libraw1394/raw1394.h>
#include <stdio.h>
#include <string.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "FireWire SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
static int raw_sdk(void) {
  CHECK(raw1394_get_libversion() && strlen(raw1394_get_libversion()) > 0);
  raw1394handle_t handle = raw1394_new_handle();
  CHECK(handle);
  struct raw1394_portinfo ports[8];
  int count = raw1394_get_port_info(handle, ports, 8);
  CHECK(count >= 0);
  int owned = 42;
  raw1394_set_userdata(handle, &owned);
  CHECK(raw1394_get_userdata(handle) == &owned);
  if (count == 0) CHECK(raw1394_set_port(handle, 0) < 0);
  raw1394_destroy_handle(handle);
  puts("Raw1394: real unbound handle, owned userdata, port enumeration/error and cleanup passed");
  return 0;
}

int main(void) { return raw_sdk(); }
