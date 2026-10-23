#include <assert.h>
#include <stdlib.h>
#include <leptonica/allheaders.h>

int main(void) {
  PIX *image = pixCreate(64, 32, 8);
  assert(image);
  for (int y = 0; y < 32; y++) {
    for (int x = 0; x < 64; x++) {
      assert(pixSetPixel(image, x, y, (x * 3 + y * 7) & 255) == 0);
    }
  }
  PIX *clone = pixClone(image);
  assert(clone == image);
  pixDestroy(&image);
  assert(!image && pixGetWidth(clone) == 64 && pixGetHeight(clone) == 32);
  l_uint8 *encoded = NULL;
  size_t length = 0;
  assert(pixWriteMemPng(&encoded, &length, clone, 0.0f) == 0 && encoded && length > 0);
  PIX *decoded = pixReadMemPng(encoded, length);
  lept_free(encoded);
  assert(decoded && pixGetWidth(decoded) == 64 && pixGetHeight(decoded) == 32);
  l_int32 equal = 0;
  assert(pixEqual(clone, decoded, &equal) == 0 && equal);
  PIX *binary = pixThresholdToBinary(decoded, 128);
  PIX *scaled = pixScaleGrayLI(decoded, 2.0f, 2.0f);
  assert(binary && pixGetDepth(binary) == 1);
  assert(scaled && pixGetWidth(scaled) == 128 && pixGetHeight(scaled) == 64);
  l_int32 severity = LeptMsgSeverity;
  LeptMsgSeverity = severity;
  setLeptDebugOK(0);
  assert(LeptDebugOK == 0);
  pixDestroy(&scaled);
  pixDestroy(&binary);
  pixDestroy(&decoded);
  pixDestroy(&clone);
  return 0;
}
