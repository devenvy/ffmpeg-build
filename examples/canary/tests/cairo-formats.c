#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <cairo.h>
#include <cairo-pdf.h>
#include <cairo-ps.h>
#include <cairo-svg.h>

struct Document { char *bytes; size_t size; };
static cairo_status_t append(void *closure, const unsigned char *bytes, unsigned length) {
  struct Document *document = closure;
  char *grown = realloc(document->bytes, document->size + length + 1);
  assert(grown);
  document->bytes = grown;
  memcpy(document->bytes + document->size, bytes, length);
  document->size += length;
  document->bytes[document->size] = 0;
  return CAIRO_STATUS_SUCCESS;
}
typedef cairo_surface_t *(*Create)(cairo_write_func_t, void *, double, double);
int main(void) {
  const Create formats[] = {cairo_pdf_surface_create_for_stream,
                            cairo_ps_surface_create_for_stream,
                            cairo_svg_surface_create_for_stream};
  const char *headers[] = {"%PDF-", "%!PS-Adobe", "<svg"};
  for (unsigned index = 0; index < 3; index++) {
    struct Document document = {0};
    cairo_surface_t *surface = formats[index](append, &document, 16, 16);
    assert(cairo_surface_status(surface) == CAIRO_STATUS_SUCCESS);
    cairo_t *context = cairo_create(surface);
    cairo_set_source_rgb(context, 1, 0, 0);
    cairo_rectangle(context, 2, 3, 8, 7);
    cairo_fill(context);
    assert(cairo_status(context) == CAIRO_STATUS_SUCCESS);
    cairo_destroy(context);
    cairo_surface_finish(surface);
    assert(cairo_surface_status(surface) == CAIRO_STATUS_SUCCESS && document.size > 0);
    assert(strstr(document.bytes, headers[index]));
    cairo_surface_destroy(surface);
    free(document.bytes);
  }
  puts("Cairo: owned PDF, PostScript and SVG output streams passed");
  return 0;
}
