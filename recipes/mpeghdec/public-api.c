#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <mpeghdec/mpeghdecoder.h>
#include <mpeghdec/mpeghUIManager.h>

int main(void) {
  HANDLE_MPEGH_DECODER_CONTEXT decoder = mpeghdecoder_init(2);
  assert(decoder);
  assert(mpeghdecoder_setParam(decoder, MPEGH_DEC_PARAM_TARGET_REFERENCE_LEVEL, 96) == MPEGH_DEC_OK);
  assert(mpeghdecoder_setParam(decoder, (MPEGH_DECODER_PARAMETER)65535, 0) == MPEGH_DEC_UNSUPPORTED_PARAM);
  int32_t pcm[6144] = {0};
  MPEGH_DECODER_OUTPUT_INFO info = {0};
  assert(mpeghdecoder_getSamples(decoder, pcm, 6144, &info) == MPEGH_DEC_FEED_DATA);
  assert(mpeghdecoder_flush(decoder) == MPEGH_DEC_OK);
  mpeghdecoder_destroy(decoder);
  HANDLE_MPEGH_UI_MANAGER ui = mpegh_UI_Manager_Open();
  assert(ui);
  uint16_t persistence[1024] = {0};
  /* A fresh caller-owned block is accepted with no saved scene data yet. */
  assert(mpegh_UI_SetPersistenceMemory(ui, persistence, sizeof(persistence)) == MPEGH_UI_OK_BUT_NO_VALID_DATA);
  void *saved = NULL;
  unsigned short size = 0;
  assert(mpegh_UI_GetPersistenceMemory(ui, &saved, &size) == MPEGH_UI_OK);
  assert(saved == persistence && size == sizeof(persistence));
  char xml[4096] = {0};
  unsigned flags = 0;
  MPEGH_UI_ERROR state = mpegh_UI_GetXmlSceneState(ui, xml, sizeof(xml), MPEGH_UI_FORCE_UPDATE, &flags);
  assert(state == MPEGH_UI_OK || state == MPEGH_UI_OK_BUT_NO_VALID_DATA);
  assert(mpegh_UI_SetPersistenceMemory(ui, NULL, 0) == MPEGH_UI_OK_BUT_NO_VALID_DATA);
  saved = persistence; size = sizeof(persistence);
  assert(mpegh_UI_GetPersistenceMemory(ui, &saved, &size) == MPEGH_UI_OK);
  assert(!saved && size == 0);
  mpegh_UI_Manager_Close(ui);
  puts("MPEG-H: decoder parameters/empty-frame lifecycle and UI XML/persistence ownership passed");
  return 0;
}
