#include <uavs3d.h>
#include <assert.h>
#include <stdio.h>

int main(void) {
  uavs3d_cfg_t configuration = {0};
  configuration.frm_threads = 2;
  int error = 0;
  void *decoder = uavs3d_create(&configuration, NULL, &error);
  assert(decoder);
  uavs3d_reset(decoder);
  uavs3d_delete(decoder);
  puts("Installed AVS3 C SDK creation, reset and deletion passed");
  return 0;
}
