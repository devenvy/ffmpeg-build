#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <aribb24/aribb24.h>
#include <aribb24/parser.h>
#include <aribb24/decoder.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
static const uint8_t management[] = {0x80,0xff,0xf0,0,0,0,0,0x0a,0x3f,1,0,0x6a,0x70,0x6e,0x80,0,0,0,0x1c,0xb0};
static const uint8_t statement[] = {0x80,0xff,0xf0,4,0,0,0,0x0f,0x3f,0,0,0x0b,0x1f,0x20,0,0,6,0x0c,0x89,0x0e,0x46,0x46,0x42,0x38,0x7f};

static int arib(void) {
  arib_instance_t* instance = arib_instance_new(NULL);
  CHECK(instance);
  arib_parser_t* parser = arib_get_parser(instance);
  arib_decoder_t* decoder = arib_get_decoder(instance);
  CHECK(parser && decoder);
  arib_initialize_decoder_a_profile(decoder);
  arib_parse_pes(parser, management, sizeof(management));
  arib_parse_pes(parser, statement, sizeof(statement));
  size_t size = 0;
  const unsigned char* body = arib_parser_get_data(parser, &size);
  CHECK(body && size == 6);
  char text[1024];
  const size_t decoded = arib_decode_buffer(decoder, body, size, text, sizeof(text) - 1);
  CHECK(decoded > 0 && decoded < sizeof(text));
  text[decoded] = 0;
  printf("ARIBB24 decoded authored caption: %s\n", text);
  CHECK(strcmp(text, "\xef\xbc\xa6\xef\xbc\xa6\xef\xbc\xa2") == 0);
  CHECK(arib_decoder_get_regions(decoder));
  arib_instance_destroy(instance);

  return 0;
}
int main(void) { return arib(); }
