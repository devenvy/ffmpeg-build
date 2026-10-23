#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dvdread/dvd_reader.h>
#include <dvdread/ifo_read.h>
#include <dvdnav/dvdnav.h>
#include <dvdnav/dvdnav_events.h>

static void navigation(const char *path) {
  dvdnav_t *nav = NULL;
  assert(dvdnav_open(&nav, path) == DVDNAV_STATUS_OK && nav);
  int32_t titles = 0, parts = 0;
  assert(dvdnav_get_number_of_titles(nav, &titles) == DVDNAV_STATUS_OK && titles == 1);
  assert(dvdnav_get_number_of_parts(nav, 1, &parts) == DVDNAV_STATUS_OK && parts == 3);
  assert(dvdnav_title_play(nav, 2) == DVDNAV_STATUS_ERR);
  assert(dvdnav_title_play(nav, 1) == DVDNAV_STATUS_OK);
  unsigned char buffer[DVD_VIDEO_LB_LEN];
  unsigned int blocks = 0;
  int stopped = 0;
  for (unsigned int count = 0; count < 2000; count++) {
    uint8_t *block = buffer;
    int32_t event = -1, length = -1;
    assert(dvdnav_get_next_cache_block(nav, &block, &event, &length) == DVDNAV_STATUS_OK);
    if (event == DVDNAV_BLOCK_OK) {
      assert(length == DVD_VIDEO_LB_LEN && memcmp(block, "\x00\x00\x01\xba", 4) == 0);
      blocks++;
    }
    if (event == DVDNAV_STILL_FRAME) assert(dvdnav_still_skip(nav) == DVDNAV_STATUS_OK);
    if (event == DVDNAV_WAIT) assert(dvdnav_wait_skip(nav) == DVDNAV_STATUS_OK);
    if (block != buffer) assert(dvdnav_free_cache_block(nav, block) == DVDNAV_STATUS_OK);
    if (event == DVDNAV_STOP) { stopped = 1; break; }
  }
  assert(stopped && blocks > 50);
  assert(dvdnav_close(nav) == DVDNAV_STATUS_OK);
  printf("DVDNav: title/chapter queries, invalid title, %u cached blocks and natural STOP from %s passed\n", blocks, path);
}

int main(int argc, char **argv) {
  assert(argc == 3);
  navigation(argv[1]);
  navigation(argv[2]);
  return 0;
}
