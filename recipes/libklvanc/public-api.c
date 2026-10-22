#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <libklvanc/vanc.h>
#include <libklvanc/vanc-afd.h>
#include <libklvanc/smpte2038.h>

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "KLVANC failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
struct proof {
  unsigned callbacks;
  unsigned failures;
  struct klvanc_smpte2038_packetizer_s* packetizer;
};
static int afd(void* opaque, struct klvanc_context_s* context, struct klvanc_packet_afd_s* packet) {
  (void)context;
  struct proof* proof = opaque;
  ++proof->callbacks;
  if (packet->afd != AFD_FULL_FRAME || packet->aspectRatio != ASPECT_16x9 || packet->barDataFlags != BARS_NONE)
    ++proof->failures;
  if (proof->packetizer && klvanc_smpte2038_packetizer_append(proof->packetizer, &packet->hdr) < 0)
    ++proof->failures;
  return 0;
}

int main(void) {
  struct klvanc_context_s* context = NULL;
  CHECK(klvanc_context_create(&context) == 0 && context);
  struct klvanc_callbacks_s callbacks = {0};
  callbacks.afd = afd;
  context->callbacks = &callbacks;
  struct proof proof = {0};
  context->callback_context = &proof;
  context->allow_bad_checksums = 0;
  CHECK(klvanc_smpte2038_packetizer_alloc(&proof.packetizer) == 0);
  CHECK(klvanc_smpte2038_packetizer_begin(proof.packetizer) == 0);
  struct klvanc_packet_afd_s* packet = NULL;
  CHECK(klvanc_create_AFD(&packet) == 0 && packet);
  CHECK(klvanc_set_AFD_val(packet, AFD_FULL_FRAME) == 0);
  packet->aspectRatio = ASPECT_16x9;
  packet->barDataFlags = BARS_NONE;
  uint16_t* words = NULL;
  uint16_t count = 0;
  CHECK(klvanc_convert_AFD_to_words(packet, &words, &count) == 0 && words && count > 0);
  CHECK(klvanc_packet_parse(context, 9, words, count) >= 0);
  CHECK(proof.callbacks == 1 && proof.failures == 0);
  CHECK(klvanc_smpte2038_packetizer_end(proof.packetizer, 90000) == 0);
  CHECK(proof.packetizer->bufused > 0);
  struct klvanc_smpte2038_anc_data_packet_s* decoded = NULL;
  CHECK(klvanc_smpte2038_parse_pes_packet(proof.packetizer->buf, proof.packetizer->bufused, &decoded) == 0);
  CHECK(decoded && decoded->lineCount == 1 && decoded->PTS == 90000);
  CHECK(decoded->lines[0].line_number == 9);
  CHECK((decoded->lines[0].DID & 255) == 0x41 && (decoded->lines[0].SDID & 255) == 0x05);
  uint16_t* roundtrip = NULL;
  uint16_t roundtrip_count = 0;
  CHECK(klvanc_smpte2038_convert_line_to_words(&decoded->lines[0], &roundtrip, &roundtrip_count) == 0);
  CHECK(roundtrip_count == count && memcmp(roundtrip, words, count * sizeof(*words)) == 0);
  klvanc_smpte2038_packetizer_free(&proof.packetizer);
  CHECK(klvanc_packet_parse(context, 9, roundtrip, roundtrip_count) >= 0);
  CHECK(proof.callbacks == 2 && proof.failures == 0);
  words[count - 1] ^= 1;
  const unsigned bad_before = context->checksum_failures;
  klvanc_packet_parse(context, 9, words, count);
  CHECK(proof.callbacks == 2 && context->checksum_failures == bad_before + 1);
  free(roundtrip);
  free(words);
  klvanc_smpte2038_anc_data_packet_free(decoded);
  klvanc_destroy_AFD(packet);
  CHECK(klvanc_context_destroy(context) == 0);
  puts("KLVANC C SDK: authored AFD, SMPTE2038 exact words/PTS roundtrip and checksum rejection passed");
  return 0;
}
