#define _XOPEN_SOURCE_EXTENDED 1
#include <assert.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <caca.h>

static void caca_api(const char *path) {
  caca_canvas_t *canvas = caca_create_canvas(12, 4);
  assert(canvas && caca_set_color_ansi(canvas, CACA_LIGHTRED, CACA_BLUE) == 0);
  assert(caca_put_str(canvas, 0, 0, "Owned canvas") == 12);
  assert(caca_get_char(canvas, 0, 0) == 'O');
  assert(caca_set_canvas_size(canvas, 16, 6) == 0 && caca_get_char(canvas, 0, 0) == 'O');
  size_t size = 0;
  void *encoded = caca_export_canvas_to_memory(canvas, "caca", &size);
  assert(encoded && size > 0);
  caca_canvas_t *copy = caca_create_canvas(0, 0);
  assert(copy && caca_import_canvas_from_memory(copy, encoded, size, "caca") == (ssize_t)size);
  assert(caca_get_canvas_width(copy) == 16 && caca_get_canvas_height(copy) == 6);
  for (int y = 0; y < 6; y++) {
    for (int x = 0; x < 16; x++) {
      assert(caca_get_char(copy, x, y) == caca_get_char(canvas, x, y));
      assert(caca_get_attr(copy, x, y) == caca_get_attr(canvas, x, y));
    }
  }
  free(encoded);
  caca_free_canvas(copy);
  caca_free_canvas(canvas);
  uint32_t pixels[64];
  for (unsigned int index = 0; index < 64; index++) pixels[index] = 0xffff0000;
  caca_dither_t *dither = caca_create_dither(32, 8, 8, 32, 0xff0000, 0xff00, 0xff, 0xff000000);
  assert(dither);
  canvas = caca_create_canvas(16, 8);
  assert(canvas && caca_dither_bitmap(canvas, 0, 0, 16, 8, dither, pixels) == 0);
  unsigned int red_cells = 0;
  for (int y = 0; y < 8; y++) {
    for (int x = 0; x < 16; x++) {
      uint16_t foreground = caca_attr_to_rgb12_fg(caca_get_attr(canvas, x, y));
      uint16_t background = caca_attr_to_rgb12_bg(caca_get_attr(canvas, x, y));
      if (((foreground & 0xf00) >> 8) > ((foreground & 0xf0) >> 4) ||
          ((background & 0xf00) >> 8) > ((background & 0xf0) >> 4)) red_cells++;
    }
  }
  assert(red_cells > 0);
  caca_free_dither(dither);
  caca_free_canvas(canvas);
  const char expected[] = "Owned compressed terminal SDK fixture\n";
  caca_file_t *file = caca_file_open(path, "rb");
  assert(file);
  char data[sizeof(expected)] = {0};
  assert(caca_file_read(file, data, sizeof(expected) - 1) == sizeof(expected) - 1);
  assert(!memcmp(data, expected, sizeof(expected) - 1));
  assert(caca_file_tell(file) == sizeof(expected) - 1);
  assert(caca_file_read(file, data, 1) == 0 && caca_file_eof(file));
  assert(caca_file_close(file) == 0);
  puts("Caca: owned canvas/attributes/resize, exact native export/import lifetime, red dither and gzip file API passed");
}
int main(int argc, char **argv) {
  assert(argc == 2);
  caca_api(argv[1]);
  return 0;
}
