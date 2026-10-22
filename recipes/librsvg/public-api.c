#include <assert.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fontconfig/fontconfig.h>
#include <pango/pangocairo.h>
#include <librsvg/rsvg.h>
#include <hb.h>

enum { WIDTH = 256, HEIGHT = 96, BYTES = WIDTH * HEIGHT * 4 };
static const char svg[] =
  "<svg xmlns='http://www.w3.org/2000/svg' width='256' height='96'>"
  "<defs><linearGradient id='g'><stop stop-color='red'/><stop offset='1' stop-color='blue'/></linearGradient></defs>"
  "<rect width='256' height='96' fill='white'/><rect width='256' height='32' fill='url(#g)'/>"
  "<text x='12' y='80' font-family='FFB Test' font-size='32'>FFB</text></svg>";
static int weak_destroyed;
static int hb_destroyed;
static hb_user_data_key_t key;

static void weak_notify(void *data, GObject *object) {
  assert(data == &weak_destroyed && object);
  weak_destroyed++;
}
static void hb_notify(void *data) {
  assert(data == &hb_destroyed);
  hb_destroyed++;
}
static void render_svg(unsigned char *output) {
  GError *error = NULL;
  RsvgHandle *handle = rsvg_handle_new_from_data((const guint8 *)svg, strlen(svg), &error);
  assert(handle && !error);
  g_object_weak_ref(G_OBJECT(handle), weak_notify, &weak_destroyed);
  cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, WIDTH, HEIGHT);
  cairo_t *cr = cairo_create(surface);
  RsvgRectangle viewport = {0, 0, WIDTH, HEIGHT};
  assert(rsvg_handle_render_document(handle, cr, &viewport, &error) && !error);
  assert(cairo_status(cr) == CAIRO_STATUS_SUCCESS);
  cairo_surface_flush(surface);
  assert(cairo_image_surface_get_stride(surface) == WIDTH * 4);
  memcpy(output, cairo_image_surface_get_data(surface), BYTES);
  const uint32_t *pixels = (const uint32_t *)output;
  uint32_t left = pixels[16 * WIDTH + 4];
  uint32_t right = pixels[16 * WIDTH + 250];
  assert(((left >> 16) & 255) > 240 && (left & 255) < 16);
  assert((right & 255) > 240 && ((right >> 16) & 255) < 16);
  int ink = 0;
  for (int y = 40; y < 90; y++) {
    for (int x = 0; x < WIDTH; x++) {
      uint32_t pixel = pixels[y * WIDTH + x];
      assert((pixel >> 24) == 255);
      if ((pixel & 0xffffff) < 0x404040) ink++;
    }
  }
  assert(ink > 100);
  cairo_destroy(cr);
  cairo_surface_destroy(surface);
  int previous = weak_destroyed;
  g_object_unref(handle);
  assert(weak_destroyed == previous + 1);
}
static void shape(hb_font_t *font, hb_codepoint_t *glyphs, hb_position_t *advances) {
  hb_buffer_t *buffer = hb_buffer_create();
  hb_buffer_add_utf8(buffer, "FFB", -1, 0, -1);
  hb_buffer_guess_segment_properties(buffer);
  hb_buffer_set_language(buffer, hb_language_from_string("en", -1));
  hb_shape(font, buffer, NULL, 0);
  unsigned count = 0;
  hb_glyph_info_t *info = hb_buffer_get_glyph_infos(buffer, &count);
  hb_glyph_position_t *positions = hb_buffer_get_glyph_positions(buffer, NULL);
  assert(count == 3 && info && positions);
  for (unsigned index = 0; index < count; index++) {
    assert(info[index].codepoint && positions[index].x_advance > 0);
    glyphs[index] = info[index].codepoint;
    advances[index] = positions[index].x_advance;
  }
  hb_buffer_destroy(buffer);
}
static void pango_and_external_harfbuzz(void) {
  assert(g_type_is_a(PANGO_TYPE_LAYOUT, G_TYPE_OBJECT));
  assert(g_type_is_a(PANGO_TYPE_FONT_MAP, G_TYPE_OBJECT));
  PangoFontMap *map = pango_cairo_font_map_new();
  PangoContext *context = pango_font_map_create_context(map);
  PangoFontDescription *description = pango_font_description_from_string("FFB Test 24");
  PangoFont *font = pango_font_map_load_font(map, context, description);
  assert(font);
  hb_font_t *borrowed = pango_font_get_hb_font(font);
  assert(borrowed && hb_font_is_immutable(borrowed));
  hb_font_t *retained = hb_font_reference(borrowed);
  hb_codepoint_t glyph = 0;
  assert(hb_font_get_nominal_glyph(retained, 'F', &glyph) && glyph);
  assert(hb_font_get_glyph_h_advance(retained, glyph) > 0);
  hb_font_t *sub = hb_font_create_sub_font(retained);
  assert(sub && !hb_font_is_immutable(sub));
  assert(hb_font_set_user_data(sub, &key, &hb_destroyed, hb_notify, false));
  hb_codepoint_t original[3], child[3];
  hb_position_t original_advances[3], child_advances[3];
  shape(retained, original, original_advances);
  shape(sub, child, child_advances);
  assert(!memcmp(original, child, sizeof(original)));
  assert(!memcmp(original_advances, child_advances, sizeof(original_advances)));
  hb_font_destroy(sub);
  assert(hb_destroyed == 1);
  hb_font_destroy(retained);
  /* Respect Pango's transfer-none contract: font/context/map outlive HB references. */
  PangoLayout *layout = pango_layout_new(context);
  pango_layout_set_font_description(layout, description);
  pango_layout_set_text(layout, "FFB", -1);
  PangoRectangle ink, logical;
  pango_layout_get_pixel_extents(layout, &ink, &logical);
  assert(ink.width > 0 && ink.height > 0 && logical.width >= ink.width);
  cairo_surface_t *surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, WIDTH, HEIGHT);
  cairo_t *cr = cairo_create(surface);
  cairo_set_source_rgb(cr, 1, 1, 1);
  pango_cairo_show_layout(cr, layout);
  assert(cairo_status(cr) == CAIRO_STATUS_SUCCESS);
  cairo_surface_flush(surface);
  int visible = 0;
  unsigned char *pixels = cairo_image_surface_get_data(surface);
  for (int index = 0; index < BYTES; index++) visible |= pixels[index];
  assert(visible);
  cairo_destroy(cr);
  cairo_surface_destroy(surface);
  g_object_unref(layout);
  g_object_unref(font);
  pango_font_description_free(description);
  g_object_unref(context);
  g_object_unref(map);
}
int main(int argc, char **argv) {
  assert(argc == 3);
  assert(FcInit());
  FcConfig *config = FcConfigCreate();
  assert(config && FcConfigAppFontAddFile(config, (const FcChar8 *)argv[1]));
  assert(FcConfigSetCurrent(config));
  if (strcmp(argv[2], "pango-first") == 0) pango_and_external_harfbuzz();
  unsigned char *before = malloc(BYTES), *after = malloc(BYTES);
  assert(before && after);
  render_svg(before);
  if (strcmp(argv[2], "svg-first") == 0) pango_and_external_harfbuzz();
  render_svg(after);
  assert(!memcmp(before, after, BYTES));
  assert(weak_destroyed == 2 && hb_destroyed == 1);
  GError *error = NULL;
  RsvgHandle *invalid = rsvg_handle_new_from_data((const guint8 *)"<broken", 7, &error);
  assert(!invalid && error);
  g_error_free(error);
  free(before);
  free(after);
  FcConfigDestroy(config);
  puts("Pango/librsvg: owned SVG gradient/text, GObject lifetimes, both initialization orders and external HarfBuzz references/subfont/callbacks/shaping passed");
  return 0;
}
