#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libbluray/bluray.h>

static unsigned char *expected;
static size_t expected_size;
static void load_expected(const char *path) {
  FILE *source = fopen(path, "rb");
  assert(source && fseek(source, 0, SEEK_END) == 0);
  long length = ftell(source);
  assert(length > 0 && fseek(source, 0, SEEK_SET) == 0);
  expected_size = (size_t)length;
  expected = malloc(expected_size);
  assert(expected && fread(expected, 1, expected_size, source) == expected_size);
  assert(fclose(source) == 0);
}

static void bluray(const char *path) {
  BLURAY *disc = bd_open(path, NULL);
  assert(disc);
  assert(bd_get_titles(disc, TITLES_RELEVANT, 0) == 1);
  BLURAY_TITLE_INFO *title = bd_get_title_info(disc, 0, 0);
  assert(title && title->clip_count == 1 && title->chapter_count == 3);
  assert(title->duration == 16200000 && title->angle_count == 1);
  assert(title->clips[0].video_stream_count == 1 && title->clips[0].audio_stream_count == 1);
  assert(title->clips[0].video_streams[0].coding_type == BLURAY_STREAM_TYPE_VIDEO_MPEG2);
  assert(title->clips[0].audio_streams[0].coding_type == BLURAY_STREAM_TYPE_AUDIO_AC3);
  bd_free_title_info(title);
  assert(bd_select_title(disc, 0));
  assert(bd_get_title_size(disc) == expected_size);
  unsigned char buffer[8192];
  unsigned char *playback = malloc(expected_size);
  assert(playback);
  size_t total = 0;
  int bytes;
  while ((bytes = bd_read(disc, buffer, sizeof(buffer))) > 0) {
    assert(total + (size_t)bytes <= expected_size);
    memcpy(playback + total, buffer, (size_t)bytes);
    total += (size_t)bytes;
  }
  assert(bytes == 0 && total == expected_size);
  unsigned int padded = 0;
  for (size_t packet = 0; packet < expected_size; packet += 192) {
    unsigned char normalized[192];
    memcpy(normalized, expected + packet, sizeof(normalized));
    if (memcmp(playback + packet, normalized, sizeof(normalized))) {
      unsigned int pid = ((normalized[5] & 0x1f) << 8) | normalized[6];
      assert(pid == 0x1100 || pid == 0x1011);
      normalized[5] |= 0x1f;
      normalized[6] = 0xff;
      assert(memcmp(playback + packet, normalized, sizeof(normalized)) == 0);
      padded++;
    }
  }
  assert(padded == 1);
  void *raw = NULL;
  int64_t raw_size = 0;
  assert(bd_read_file(disc, "BDMV/STREAM/00000.m2ts", &raw, &raw_size));
  assert(raw && raw_size == (int64_t)expected_size && memcmp(raw, expected, expected_size) == 0);
  free(raw);
  assert(bd_seek(disc, 0) == 0);
  assert(bd_read(disc, buffer, sizeof(buffer)) == sizeof(buffer));
  assert(memcmp(buffer, playback, sizeof(buffer)) == 0);
  free(playback);
  bd_close(disc);
  printf("Blu-ray: exact %zu-byte raw file, %u boundary PID padding packets, parsed metadata, natural EOF, seek and ownership from %s passed\n", total, padded, path);
}

int main(int argc, char **argv) {
  assert(argc == 4);
  load_expected(argv[3]);
  bluray(argv[1]);
  bluray(argv[2]);
  free(expected);
  return 0;
}
