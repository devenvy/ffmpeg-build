#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <rav1e.h>

int main(void) {
  enum { WIDTH = 64, HEIGHT = 64, FRAMES = 3 };
  RaConfig *config = rav1e_config_default();
  assert(config);
  const char *names[] = {"width", "height", "speed", "threads", "low_latency", "rdo_lookahead_frames"};
  /* The native configuration validator requires at least one lookahead frame. */
  const char *values[] = {"64", "64", "10", "1", "true", "1"};
  for (unsigned index = 0; index < sizeof(names) / sizeof(names[0]); index++) {
    assert(rav1e_config_parse(config, names[index], values[index]) == 0);
  }
  assert(rav1e_config_parse(config, "ffmpeg-build-invalid-option", "1") < 0);
  RaContext *context = rav1e_context_new(config);
  assert(context);
  rav1e_config_unref(config);
  RaData *header = rav1e_container_sequence_header(context);
  assert(header && header->data && header->len > 0);
  rav1e_data_unref(header);
  for (int index = 0; index < FRAMES; index++) {
    RaFrame *frame = rav1e_frame_new(context);
    assert(frame);
    uint8_t y[WIDTH * HEIGHT], u[WIDTH * HEIGHT / 4], v[WIDTH * HEIGHT / 4];
    for (int row = 0; row < HEIGHT; row++) {
      for (int col = 0; col < WIDTH; col++) y[row * WIDTH + col] = 32 + index * 32 + (row + col) % 8;
    }
    memset(u, 96 + index * 2, sizeof(u));
    memset(v, 160 - index * 2, sizeof(v));
    rav1e_frame_fill_plane(frame, 0, y, sizeof(y), WIDTH, 1);
    rav1e_frame_fill_plane(frame, 1, u, sizeof(u), WIDTH / 2, 1);
    rav1e_frame_fill_plane(frame, 2, v, sizeof(v), WIDTH / 2, 1);
    assert(rav1e_send_frame(context, frame) == RA_ENCODER_STATUS_SUCCESS);
    rav1e_frame_unref(frame);
  }
  assert(rav1e_send_frame(context, NULL) == RA_ENCODER_STATUS_SUCCESS);
  bool seen[FRAMES] = {false};
  unsigned packets = 0;
  bool ended = false;
  for (int attempt = 0; attempt < 64; attempt++) {
    RaPacket *packet = NULL;
    int status = rav1e_receive_packet(context, &packet);
    if (status == RA_ENCODER_STATUS_LIMIT_REACHED) {
      ended = true;
      break;
    }
    if (status == RA_ENCODER_STATUS_ENCODED || status == RA_ENCODER_STATUS_NEED_MORE_DATA) continue;
    assert(status == RA_ENCODER_STATUS_SUCCESS && packet && packet->data && packet->len > 0);
    assert(packet->input_frameno < FRAMES && !seen[packet->input_frameno]);
    seen[packet->input_frameno] = true;
    packets++;
    rav1e_packet_unref(packet);
  }
  assert(ended && packets == FRAMES);
  for (int index = 0; index < FRAMES; index++) assert(seen[index]);
  rav1e_context_unref(context);
  puts("rav1e: owned I420 frames, sequence header, all packets through natural encoder EOF and matched allocation/unref lifecycle passed");
  return 0;
}
