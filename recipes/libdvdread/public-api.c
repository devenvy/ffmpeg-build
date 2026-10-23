#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dvdread/dvd_reader.h>
#include <dvdread/ifo_read.h>

static void reading(const char *path, const char *vob_path) {
  dvd_reader_t *reader = DVDOpen(path);
  assert(reader);
  ifo_handle_t *manager = ifoOpen(reader, 0);
  assert(manager && manager->tt_srpt && manager->tt_srpt->nr_of_srpts == 1);
  assert(manager->tt_srpt->title[0].nr_of_ptts == 3);
  ifo_handle_t *title = ifoOpen(reader, 1);
  assert(title && title->vtsi_mat);
  assert(title->vtsi_mat->vts_video_attr.video_format == 1);
  assert(title->vtsi_mat->vts_audio_attr[0].audio_format == 0);
  dvd_file_t *file = DVDOpenFile(reader, 1, DVD_READ_TITLE_VOBS);
  assert(file);
  ssize_t blocks = DVDFileSize(file);
  assert(blocks > 50 && blocks < 1000);
  size_t length = (size_t)blocks * DVD_VIDEO_LB_LEN;
  unsigned char *actual = malloc(length);
  unsigned char *expected = malloc(length);
  assert(actual && expected);
  FILE *source = fopen(vob_path, "rb");
  assert(source && fread(expected, 1, length, source) == length);
  assert(fgetc(source) == EOF && fclose(source) == 0);
  assert(DVDReadBlocks(file, 0, (size_t)blocks, actual) == blocks);
  assert(memcmp(actual, expected, length) == 0);
  assert(memcmp(actual, "\x00\x00\x01\xba", 4) == 0);
  free(expected);
  free(actual);
  DVDCloseFile(file);
  ifoClose(title);
  ifoClose(manager);
  DVDClose(reader);
  printf("DVDRead: exact %zu-byte title, PAL/AC3 IFO and three chapters from %s passed\n", length, path);
}

int main(int argc, char **argv) {
  assert(argc == 4);
  reading(argv[1], argv[3]);
  reading(argv[2], argv[3]);
  return 0;
}
