#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <libzvbi.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
static void event(vbi_event* event, void* opaque) {
  if (event->type == VBI_EVENT_TTX_PAGE) ++*(unsigned*)opaque;
}

static int teletext(void) {
  vbi_decoder* decoder = vbi_decoder_new();
  CHECK(decoder);
  unsigned events = 0;
  CHECK(vbi_event_handler_add(decoder, VBI_EVENT_TTX_PAGE, event, &events));
  vbi_sliced lines[3] = {0};
  for (size_t packet = 0; packet < 3; ++packet) {
    lines[packet].id = VBI_SLICED_TELETEXT_B;
    lines[packet].line = 7 + packet;
    const unsigned row = packet == 1 ? 1 : 0;
    const unsigned address = (row << 3) | 1;
    lines[packet].data[0] = vbi_ham8(address & 15);
    lines[packet].data[1] = vbi_ham8(address >> 4);
    for (size_t i = 2; i < 42; ++i) lines[packet].data[i] = vbi_par8(' ');
    if (row == 0) {
      for (size_t i = 2; i < 10; ++i) lines[packet].data[i] = vbi_ham8(0);
      if (packet == 2) lines[packet].data[2] = vbi_ham8(1);
    } else {
      const char text[] = "FFB authored Teletext";
      for (size_t i = 0; i < sizeof(text) - 1; ++i) lines[packet].data[2 + i] = vbi_par8(text[i]);
    }
  }
  CHECK(vbi_rev8(1) == 128 && vbi_unham8(vbi_ham8(9)) == 9);
  vbi_decode(decoder, lines, 3, 0.0);
  vbi_page page;
  CHECK(vbi_fetch_vt_page(decoder, &page, 0x100, VBI_ANY_SUBNO, VBI_WST_LEVEL_1, 25, FALSE));
  const char text[] = "FFB authored Teletext";
  for (size_t i = 0; i < sizeof(text) - 1; ++i) CHECK(page.text[page.columns + i].unicode == (unsigned)text[i]);
  CHECK(events > 0);
  vbi_unref_page(&page);
  vbi_decoder_delete(decoder);
  puts("ZVBI C SDK: authored page100 text, event and installed inline helpers passed");
  return 0;
}

int main(void) { return teletext(); }
