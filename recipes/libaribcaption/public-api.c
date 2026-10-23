#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <aribcaption/aribcaption.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
static const uint8_t management[] = {0x80,0xff,0xf0,0,0,0,0,0x0a,0x3f,1,0,0x6a,0x70,0x6e,0x80,0,0,0,0x1c,0xb0};
static const uint8_t statement[] = {0x80,0xff,0xf0,4,0,0,0,0x0f,0x3f,0,0,0x0b,0x1f,0x20,0,0,6,0x0c,0x89,0x0e,0x46,0x46,0x42,0x38,0x7f};

static int arib(void) {
  aribcc_context_t* context = aribcc_context_alloc();
  CHECK(context);
  aribcc_decoder_t* cc = aribcc_decoder_alloc(context);
  CHECK(cc);
  CHECK(aribcc_decoder_initialize(cc, ARIBCC_ENCODING_SCHEME_ARIB_STD_B24_JIS,
        ARIBCC_CAPTIONTYPE_CAPTION, ARIBCC_PROFILE_A, ARIBCC_LANGUAGEID_FIRST));
  aribcc_decoder_set_replace_msz_fullwidth_ascii(cc, true);
  aribcc_caption_t caption = {0};
  CHECK(aribcc_decoder_decode(cc, management, sizeof(management), 0, &caption) == ARIBCC_DECODE_STATUS_NO_CAPTION);
  CHECK(aribcc_decoder_decode(cc, statement, sizeof(statement), 0, &caption) == ARIBCC_DECODE_STATUS_GOT_CAPTION);
  CHECK(caption.text && strcmp(caption.text, "FFB") == 0);
  aribcc_renderer_t* renderer = aribcc_renderer_alloc(context);
  CHECK(renderer);
  CHECK(aribcc_renderer_initialize(renderer, ARIBCC_CAPTIONTYPE_CAPTION,
        ARIBCC_FONTPROVIDER_TYPE_AUTO, ARIBCC_TEXTRENDERER_TYPE_AUTO));
  CHECK(aribcc_renderer_set_frame_size(renderer, 960, 540));
  const char* families[] = {"FFB Test"};
  CHECK(aribcc_renderer_set_default_font_family(renderer, families, 1, true));
  CHECK(aribcc_renderer_append_caption(renderer, &caption));
  aribcc_caption_cleanup(&caption);
  aribcc_render_result_t result = {0};
  CHECK(aribcc_renderer_render(renderer, 0, &result) == ARIBCC_RENDER_STATUS_GOT_IMAGE);
  CHECK(result.image_count > 0);
  size_t visible = 0;
  for (size_t image = 0; image < result.image_count; ++image) {
    for (size_t offset = 3; offset < result.images[image].bitmap_size; offset += 4) {
      visible += result.images[image].bitmap[offset] > 0;
    }
  }
  CHECK(visible > 0);
  aribcc_render_result_cleanup(&result);
  aribcc_renderer_free(renderer);
  aribcc_decoder_free(cc);
  aribcc_context_free(context);
  puts("ARIB Caption C SDK: own text and visible authored-font bitmap passed");
  return 0;
}

int main(void) { return arib(); }
