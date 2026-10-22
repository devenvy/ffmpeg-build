#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <cairo.h>
#include <cairo-ft.h>
#include <fontconfig/fontconfig.h>

static FcConfig *configuration(void) {
  assert(FcInit());
  const char *filename = getenv("FONTCONFIG_FILE");
  assert(filename && *filename);
  FcConfig *config = FcConfigCreate();
  assert(config && FcConfigParseAndLoad(config, (const FcChar8 *)filename, FcTrue));
  return config;
}
int main(int argc, char **argv) {
  assert(argc == 2 && setenv("FONTCONFIG_USE_MMAP", "1", 1) == 0);
  FcConfig *config = configuration();
  FcCache *cache = FcDirCacheRead((const FcChar8 *)argv[1], FcTrue, config);
  assert(cache && FcCacheNumFont(cache) > 0);
  FcDirCacheUnload(cache);
  FcConfigDestroy(config);
  FcFini();
  config = configuration();
  FcChar8 *filename = NULL;
  cache = FcDirCacheLoad((const FcChar8 *)argv[1], config, &filename);
  assert(cache && filename && FcCacheNumFont(cache) > 0);
  const char *basename = strrchr((const char *)filename, '/');
  assert(basename && *++basename);
  FILE *maps = fopen("/proc/self/maps", "r");
  assert(maps);
  char line[8192];
  int mapped = 0;
  while (fgets(line, sizeof(line), maps)) {
    if (strstr(line, basename)) mapped = 1;
  }
  fclose(maps);
  assert(mapped);
  FcFontSet *fonts = FcCacheCopySet(cache);
  assert(fonts && fonts->nfont > 0);
  FcPattern *pattern = fonts->fonts[0];
  FcPatternReference(pattern);
  FcFontSetDestroy(fonts);
  FcDirCacheUnload(cache);
  FcStrFree(filename);
  FcConfigDestroy(config);
  cairo_font_face_t *face = cairo_ft_font_face_create_for_pattern(pattern);
  FcPatternDestroy(pattern);
  assert(cairo_font_face_status(face) == CAIRO_STATUS_SUCCESS);
  cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 96, 48);
  cairo_t *context = cairo_create(surface);
  cairo_set_font_face(context, face);
  cairo_set_font_size(context, 24);
  cairo_move_to(context, 2, 30);
  cairo_set_source_rgb(context, 1, 1, 1);
  cairo_show_text(context, "FFB");
  assert(cairo_status(context) == CAIRO_STATUS_SUCCESS);
  cairo_surface_flush(surface);
  unsigned char *pixels = cairo_image_surface_get_data(surface);
  int bytes = cairo_image_surface_get_stride(surface) * 48;
  int nonzero = 0;
  for (int index = 0; index < bytes; index++) nonzero |= pixels[index];
  assert(nonzero);
  cairo_destroy(context);
  cairo_font_face_destroy(face);
  cairo_surface_destroy(surface);
  cairo_debug_reset_static_data();
  FcFini();
  puts("Cairo: real mmap cache receipt, retained external Fontconfig pattern, released cache/config handles and rendered glyphs passed");
  return 0;
}
