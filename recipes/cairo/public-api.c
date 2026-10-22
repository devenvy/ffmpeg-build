#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <cairo.h>
#include <cairo-ft.h>
#include <cairo-gobject.h>
#include <cairo-script.h>
#include <cairo-script-interpreter.h>
#include <fontconfig/fontconfig.h>
#include <fontconfig/fcfreetype.h>
#include <ft2build.h>
#include FT_FREETYPE_H
#include FT_MODULE_H

struct Buffer { unsigned char *data; size_t size; };
static cairo_status_t append(void *closure, const unsigned char *data, unsigned length) {
  struct Buffer *buffer = closure;
  unsigned char *grown = realloc(buffer->data, buffer->size + length);
  assert(grown);
  buffer->data = grown;
  memcpy(buffer->data + buffer->size, data, length);
  buffer->size += length;
  return CAIRO_STATUS_SUCCESS;
}
struct Script { cairo_surface_t *surface; unsigned created; };
static cairo_surface_t *script_surface(void *closure, cairo_content_t content,
                                      double width, double height, long uid) {
  (void)content; (void)uid;
  struct Script *script = closure;
  assert(width == 8 && height == 8 && !script->surface);
  cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, (int)width, (int)height);
  script->surface = cairo_surface_reference(surface);
  script->created++;
  return surface;
}
static unsigned surface_freed;
static void surface_done(void *data) { assert(data == &surface_freed); surface_freed++; }
static unsigned long ft_active;
static unsigned face_freed;
static void *ft_alloc(FT_Memory memory, long size) {
  (void)memory;
  void *result = malloc((size_t)size);
  if (result) ft_active++;
  return result;
}
static void ft_free(FT_Memory memory, void *block) {
  (void)memory;
  if (block) { assert(ft_active > 0); ft_active--; free(block); }
}
static void *ft_realloc(FT_Memory memory, long old_size, long new_size, void *block) {
  (void)memory; (void)old_size;
  if (!block) return ft_alloc(memory, new_size);
  if (!new_size) { ft_free(memory, block); return NULL; }
  return realloc(block, (size_t)new_size);
}
static void face_finalizer(void *object) {
  FT_Face face = object;
  assert(face->generic.data == &face_freed);
  face_freed++;
}
static void release_face(void *face) { assert(FT_Done_Face(face) == 0); }
static void image_and_script(void) {
  static cairo_user_data_key_t key;
  cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 8, 8);
  assert(cairo_surface_set_user_data(surface, &key, &surface_freed, surface_done) == CAIRO_STATUS_SUCCESS);
  cairo_t *context = cairo_create(surface);
  cairo_set_source_rgb(context, 1, 0, 0);
  cairo_paint(context);
  assert(cairo_status(context) == CAIRO_STATUS_SUCCESS);
  cairo_destroy(context);
  GValue boxed = G_VALUE_INIT;
  g_value_init(&boxed, cairo_gobject_surface_get_type());
  g_value_set_boxed(&boxed, surface);
  cairo_surface_destroy(surface);
  surface = g_value_get_boxed(&boxed);
  assert(surface && !surface_freed);
  cairo_surface_flush(surface);
  uint32_t pixel;
  memcpy(&pixel, cairo_image_surface_get_data(surface), sizeof(pixel));
  assert(pixel == UINT32_C(0xffff0000));
  struct Buffer png = {0};
  assert(cairo_surface_write_to_png_stream(surface, append, &png) == CAIRO_STATUS_SUCCESS);
  assert(png.size > 8 && memcmp(png.data, "\x89PNG\r\n\x1a\n", 8) == 0);
  free(png.data);
  g_value_unset(&boxed);
  assert(surface_freed == 1);
  struct Buffer commands = {0};
  cairo_device_t *device = cairo_script_create_for_stream(append, &commands);
  surface = cairo_script_surface_create(device, CAIRO_CONTENT_COLOR_ALPHA, 8, 8);
  context = cairo_create(surface);
  cairo_set_source_rgb(context, 1, 0, 0);
  cairo_paint(context);
  cairo_destroy(context);
  cairo_surface_destroy(surface);
  cairo_device_finish(device);
  assert(cairo_device_status(device) == CAIRO_STATUS_SUCCESS && commands.size > 0);
  cairo_device_destroy(device);
  struct Script script = {0};
  cairo_script_interpreter_hooks_t hooks = {0};
  hooks.closure = &script;
  hooks.surface_create = script_surface;
  cairo_script_interpreter_t *interpreter = cairo_script_interpreter_create();
  cairo_script_interpreter_install_hooks(interpreter, &hooks);
  assert(cairo_script_interpreter_feed_string(interpreter, (const char *)commands.data, (int)commands.size) == CAIRO_STATUS_SUCCESS);
  assert(cairo_script_interpreter_finish(interpreter) == CAIRO_STATUS_SUCCESS);
  assert(cairo_script_interpreter_destroy(interpreter) == CAIRO_STATUS_SUCCESS);
  assert(script.created == 1 && script.surface);
  cairo_surface_flush(script.surface);
  memcpy(&pixel, cairo_image_surface_get_data(script.surface), sizeof(pixel));
  assert(pixel == UINT32_C(0xffff0000));
  cairo_surface_destroy(script.surface);
  free(commands.data);
}
static void fonts(const char *font) {
  struct FT_MemoryRec_ memory = {0};
  memory.alloc = ft_alloc; memory.free = ft_free; memory.realloc = ft_realloc;
  FT_Library library;
  assert(FT_New_Library(&memory, &library) == 0);
  FT_Add_Default_Modules(library);
  FT_Face face;
  assert(FT_New_Face(library, font, 0, &face) == 0);
  face->generic.data = &face_freed;
  face->generic.finalizer = face_finalizer;
  assert(FT_Set_Pixel_Sizes(face, 0, 24) == 0);
  FT_UInt glyph = FT_Get_Char_Index(face, 'F');
  assert(glyph > 0 && FcFreeTypeCharIndex(face, 'F') == glyph);
  FcPattern *pattern = FcFreeTypeQueryFace(face, (const FcChar8 *)font, 0, NULL);
  assert(pattern);
  FcCharSet *charset = FcFreeTypeCharSet(face, NULL);
  assert(charset && FcCharSetHasChar(charset, 'F'));
  FcCharSetDestroy(charset);
  FcPatternDestroy(pattern);
  cairo_font_face_t *cairo_face = cairo_ft_font_face_create_for_ft_face(face, 0);
  assert(cairo_font_face_status(cairo_face) == CAIRO_STATUS_SUCCESS);
  static cairo_user_data_key_t key;
  assert(cairo_font_face_set_user_data(cairo_face, &key, face, release_face) == CAIRO_STATUS_SUCCESS);
  cairo_matrix_t font_matrix, transform;
  cairo_matrix_init_scale(&font_matrix, 24, 24);
  cairo_matrix_init_identity(&transform);
  cairo_font_options_t *options = cairo_font_options_create();
  cairo_scaled_font_t *scaled = cairo_scaled_font_create(cairo_face, &font_matrix, &transform, options);
  assert(cairo_scaled_font_status(scaled) == CAIRO_STATUS_SUCCESS);
  FT_Face borrowed = cairo_ft_scaled_font_lock_face(scaled);
  assert(borrowed == face && FT_Get_Char_Index(borrowed, 'F') == glyph);
  assert(FT_Load_Char(borrowed, 'F', FT_LOAD_DEFAULT) == 0);
  cairo_ft_scaled_font_unlock_face(scaled);
  cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 96, 48);
  cairo_t *context = cairo_create(surface);
  cairo_set_scaled_font(context, scaled);
  cairo_set_source_rgb(context, 1, 1, 1);
  cairo_move_to(context, 2, 30);
  cairo_show_text(context, "FFB");
  assert(cairo_status(context) == CAIRO_STATUS_SUCCESS);
  cairo_surface_flush(surface);
  int nonzero = 0;
  unsigned char *pixels = cairo_image_surface_get_data(surface);
  int bytes = cairo_image_surface_get_stride(surface) * 48;
  for (int index = 0; index < bytes; index++) nonzero |= pixels[index];
  assert(nonzero);
  cairo_destroy(context);
  cairo_surface_destroy(surface);
  cairo_scaled_font_destroy(scaled);
  cairo_font_options_destroy(options);
  cairo_font_face_destroy(cairo_face);
  cairo_debug_reset_static_data();
  assert(face_freed == 1);
  assert(FT_Done_Library(library) == 0 && ft_active == 0);
}
static void cached_font(const char *font) {
  char *directory = strdup(font);
  assert(directory);
  char *separator = strrchr(directory, '/');
  assert(separator);
  *separator = 0;
  FcConfig *config = FcInitLoadConfigAndFonts();
  assert(config && FcConfigSetCurrent(config));
  FcCache *cache = FcDirCacheRead((const FcChar8 *)directory, FcTrue, config);
  assert(cache && FcCacheNumFont(cache) > 0);
  FcFontSet *set = FcCacheCopySet(cache);
  assert(set && set->nfont > 0);
  FcPattern *pattern = set->fonts[0];
  FcPatternReference(pattern);
  FcDirCacheUnload(cache);
  FcFontSetDestroy(set);
  FcConfig *replacement = FcInitLoadConfigAndFonts();
  assert(replacement && FcConfigSetCurrent(replacement));
  FcConfigDestroy(config);
  FcConfigDestroy(replacement);
  cairo_font_face_t *face = cairo_ft_font_face_create_for_pattern(pattern);
  FcPatternDestroy(pattern);
  assert(cairo_font_face_status(face) == CAIRO_STATUS_SUCCESS);
  cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, 96, 48);
  cairo_t *context = cairo_create(surface);
  cairo_set_font_face(context, face);
  cairo_set_font_size(context, 24);
  cairo_set_source_rgb(context, 1, 1, 1);
  cairo_move_to(context, 2, 30);
  cairo_show_text(context, "FFB");
  assert(cairo_status(context) == CAIRO_STATUS_SUCCESS);
  cairo_surface_flush(surface);
  int nonzero = 0;
  unsigned char *pixels = cairo_image_surface_get_data(surface);
  int bytes = cairo_image_surface_get_stride(surface) * 48;
  for (int index = 0; index < bytes; index++) nonzero |= pixels[index];
  assert(nonzero);
  cairo_destroy(context);
  cairo_font_face_destroy(face);
  cairo_surface_destroy(surface);
  cairo_debug_reset_static_data();
  free(directory);
}
int main(int argc, char **argv) {
  assert(argc == 2);
  image_and_script();
  fonts(argv[1]);
  cached_font(argv[1]);
  FcFini();
  puts("Cairo: boxed surface ownership, PNG, script interpreter pixels, external FT/Fontconfig handles and tracked face/allocator lifecycle passed");
  return 0;
}
