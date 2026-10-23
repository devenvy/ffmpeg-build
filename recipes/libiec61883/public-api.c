#include <libraw1394/raw1394.h>
#include <libiec61883/iec61883.h>
#include <stdio.h>
#include <string.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "FireWire SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
static int received(unsigned char *data, int length, unsigned dropped, void *opaque) {
  (void)data; (void)length; (void)dropped;
  ++*(unsigned *)opaque;
  return 0;
}
static int iec_sdk(void) {
  raw1394handle_t handle = raw1394_new_handle();
  CHECK(handle);
  unsigned callbacks = 0;
  iec61883_mpeg2_t stream = iec61883_mpeg2_recv_init(handle, received, &callbacks);
  CHECK(stream);
  CHECK(iec61883_mpeg2_get_callback_data(stream) == &callbacks);
  iec61883_mpeg2_set_buffers(stream, 64);
  iec61883_mpeg2_set_prebuffers(stream, 16);
  iec61883_mpeg2_set_irq_interval(stream, 8);
  iec61883_mpeg2_set_speed(stream, RAW1394_ISO_SPEED_200);
  iec61883_mpeg2_set_synch(stream, 0);
  CHECK(iec61883_mpeg2_get_buffers(stream) == 64);
  CHECK(iec61883_mpeg2_get_prebuffers(stream) == 16);
  CHECK(iec61883_mpeg2_get_irq_interval(stream) == 8);
  CHECK(iec61883_mpeg2_get_speed(stream) == RAW1394_ISO_SPEED_200);
  CHECK(iec61883_mpeg2_get_synch(stream) == 0 && iec61883_mpeg2_get_dropped(stream) == 0);
  CHECK(callbacks == 0);
  iec61883_mpeg2_close(stream);
  raw1394_destroy_handle(handle);
  puts("IEC61883: genuine unbound raw handle, MPEG2 receive-object settings/data ownership and cleanup passed; no bus stream claimed");
  return 0;
}

int main(void) { return iec_sdk(); }
