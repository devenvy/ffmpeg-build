#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <LCEVC/lcevc_dec.h>

static uint8_t value(unsigned plane, unsigned row, unsigned col, unsigned frame) {
  return (uint8_t)((plane * 61 + row * 7 + col * 3 + frame * 11) & 255);
}
static void pixels(LCEVC_DecoderHandle decoder, LCEVC_PictureHandle picture,
                   unsigned frame, int write) {
  LCEVC_PictureLockHandle lock = {0};
  assert(LCEVC_LockPicture(decoder, picture, write ? LCEVC_Access_Write : LCEVC_Access_Read, &lock) == LCEVC_Success);
  for (unsigned plane = 0; plane < 3; plane++) {
    LCEVC_PicturePlaneDesc desc = {0};
    assert(LCEVC_GetPictureLockPlaneDesc(decoder, lock, plane, &desc) == LCEVC_Success);
    unsigned width = plane ? 32 : 64;
    unsigned height = plane ? 16 : 32;
    assert(desc.firstSample && desc.rowByteStride >= width);
    for (unsigned y = 0; y < height; y++) {
      for (unsigned x = 0; x < width; x++) {
        uint8_t *sample = desc.firstSample + y * desc.rowByteStride + x;
        if (write) *sample = value(plane, y, x, frame);
        else assert(*sample == value(plane, y, x, frame));
      }
    }
  }
  assert(LCEVC_UnlockPicture(decoder, lock) == LCEVC_Success);
}
int main(void) {
  LCEVC_DecoderHandle decoder = {0};
  LCEVC_AccelContextHandle acceleration = {0};
  assert(LCEVC_CreateDecoder(&decoder, acceleration) == LCEVC_Success);
  assert(LCEVC_ConfigureDecoderString(decoder, "pipeline", "cpu") == LCEVC_Success);
  assert(LCEVC_ConfigureDecoderInt(decoder, "threads", 1) == LCEVC_Success);
  assert(LCEVC_ConfigureDecoderInt(decoder, "passthrough_mode", 0) == LCEVC_Success);
  assert(LCEVC_InitializeDecoder(decoder) == LCEVC_Success);
  LCEVC_PictureDesc input = {0};
  assert(LCEVC_DefaultPictureDesc(&input, LCEVC_I420_8, 64, 32) == LCEVC_Success);
  LCEVC_PictureHandle base = {0};
  assert(LCEVC_AllocPicture(decoder, &input, &base) == LCEVC_Success);
  for (unsigned frame = 0; frame < 4; frame++) {
    pixels(decoder, base, frame, 1);
    uint64_t pts = 100 + frame;
    assert(LCEVC_SendDecoderEnhancementData(decoder, pts, NULL, 0) == LCEVC_Success);
    assert(LCEVC_SendDecoderBase(decoder, pts, base, UINT32_MAX, NULL) == LCEVC_Success);
    LCEVC_PictureDesc output = {0};
    assert(LCEVC_PeekDecoderPictureDesc(decoder, pts, &output) == LCEVC_Success);
    assert(output.width == 64 && output.height == 32);
    LCEVC_PictureHandle picture = {0};
    assert(LCEVC_AllocPicture(decoder, &output, &picture) == LCEVC_Success);
    assert(LCEVC_SendDecoderPicture(decoder, picture) == LCEVC_Success);
    assert(LCEVC_SynchronizeDecoder(decoder, 0) == LCEVC_Success);
    LCEVC_DecodeInformation info = {0};
    LCEVC_PictureHandle received = {0};
    assert(LCEVC_ReceiveDecoderPicture(decoder, &received, &info) == LCEVC_Success);
    assert(received.hdl == picture.hdl && info.timestamp == pts && !info.hasEnhancement);
    pixels(decoder, received, frame, 0);
    LCEVC_PictureHandle released = {0};
    assert(LCEVC_ReceiveDecoderBase(decoder, &released) == LCEVC_Success && released.hdl == base.hdl);
    assert(LCEVC_FreePicture(decoder, received) == LCEVC_Success);
  }
  assert(LCEVC_FreePicture(decoder, base) == LCEVC_Success);
  LCEVC_DestroyDecoder(decoder);
  puts("LCEVC: four exact CPU passthrough frames, timestamps, picture locks and ownership passed; enhancement decoding not claimed");
  return 0;
}
