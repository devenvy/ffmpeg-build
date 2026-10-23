#include <brotli/decode.h>
#include <brotli/encode.h>
#include <brotli/shared_dictionary.h>
#include <jxl/cms.h>
#include <jxl/decode.h>
#include <jxl/encode.h>
#include <jxl/thread_parallel_runner.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)

int main(void) {
  const unsigned char text[] = "Authored Brotli SDK payload: dictionary, encoder and decoder remain public.";
  unsigned char compressed[1024], restored[1024];
  size_t compressed_size = sizeof(compressed), restored_size = sizeof(restored);
  CHECK(BrotliEncoderCompress(5, BROTLI_DEFAULT_WINDOW, BROTLI_MODE_TEXT, sizeof(text), text, &compressed_size, compressed));
  CHECK(BrotliDecoderDecompress(compressed_size, compressed, &restored_size, restored) == BROTLI_DECODER_RESULT_SUCCESS);
  CHECK(restored_size == sizeof(text) && memcmp(text, restored, sizeof(text)) == 0);
  restored_size = sizeof(restored);
  CHECK(BrotliDecoderDecompress(compressed_size / 2, compressed, &restored_size, restored) != BROTLI_DECODER_RESULT_SUCCESS);
  BrotliSharedDictionary* dictionary = BrotliSharedDictionaryCreateInstance(NULL, NULL, NULL);
  CHECK(dictionary);
  CHECK(BrotliSharedDictionaryAttach(dictionary, BROTLI_SHARED_DICTIONARY_RAW, sizeof(text), text));
  BrotliSharedDictionaryDestroyInstance(dictionary);

  unsigned char pixels[16 * 12 * 3], encoded[65536], decoded[sizeof(pixels)];
  for (size_t i = 0; i < sizeof(pixels); ++i) pixels[i] = (unsigned char)(i * 37 + i / 7);
  JxlEncoder* encoder = JxlEncoderCreate(NULL);
  CHECK(encoder);
  void* runner = JxlThreadParallelRunnerCreate(NULL, 2);
  CHECK(runner);
  CHECK(JxlEncoderSetParallelRunner(encoder, JxlThreadParallelRunner, runner) == JXL_ENC_SUCCESS);
  const JxlCmsInterface* cms = JxlGetDefaultCms();
  CHECK(cms && cms->init && cms->run && cms->destroy);
  JxlEncoderSetCms(encoder, *cms);
  JxlBasicInfo info;
  JxlEncoderInitBasicInfo(&info);
  info.xsize = 16;
  info.ysize = 12;
  info.bits_per_sample = 8;
  info.num_color_channels = 3;
  info.uses_original_profile = JXL_TRUE;
  CHECK(JxlEncoderSetBasicInfo(encoder, &info) == JXL_ENC_SUCCESS);
  JxlColorEncoding color;
  JxlColorEncodingSetToSRGB(&color, JXL_FALSE);
  CHECK(JxlEncoderSetColorEncoding(encoder, &color) == JXL_ENC_SUCCESS);
  JxlEncoderFrameSettings* settings = JxlEncoderFrameSettingsCreate(encoder, NULL);
  CHECK(settings);
  CHECK(JxlEncoderSetFrameLossless(settings, JXL_TRUE) == JXL_ENC_SUCCESS);
  JxlPixelFormat format = {3, JXL_TYPE_UINT8, JXL_NATIVE_ENDIAN, 0};
  CHECK(JxlEncoderAddImageFrame(settings, &format, pixels, sizeof(pixels)) == JXL_ENC_SUCCESS);
  JxlEncoderCloseInput(encoder);
  unsigned char* next = encoded;
  size_t available = sizeof(encoded);
  CHECK(JxlEncoderProcessOutput(encoder, &next, &available) == JXL_ENC_SUCCESS);
  const size_t encoded_size = sizeof(encoded) - available;
  JxlEncoderDestroy(encoder);
  JxlDecoder* decoder = JxlDecoderCreate(NULL);
  CHECK(decoder);
  CHECK(JxlDecoderSetParallelRunner(decoder, JxlThreadParallelRunner, runner) == JXL_DEC_SUCCESS);
  CHECK(JxlDecoderSubscribeEvents(decoder, JXL_DEC_BASIC_INFO | JXL_DEC_FULL_IMAGE) == JXL_DEC_SUCCESS);
  CHECK(JxlDecoderSetInput(decoder, encoded, encoded_size) == JXL_DEC_SUCCESS);
  JxlDecoderCloseInput(decoder);
  int images = 0;
  for (;;) {
    JxlDecoderStatus status = JxlDecoderProcessInput(decoder);
    if (status == JXL_DEC_BASIC_INFO) {
      CHECK(JxlDecoderGetBasicInfo(decoder, &info) == JXL_DEC_SUCCESS);
      CHECK(info.xsize == 16 && info.ysize == 12);
    } else if (status == JXL_DEC_NEED_IMAGE_OUT_BUFFER) {
      size_t size = 0;
      CHECK(JxlDecoderImageOutBufferSize(decoder, &format, &size) == JXL_DEC_SUCCESS);
      CHECK(size == sizeof(decoded));
      CHECK(JxlDecoderSetImageOutBuffer(decoder, &format, decoded, sizeof(decoded)) == JXL_DEC_SUCCESS);
    } else if (status == JXL_DEC_FULL_IMAGE) {
      ++images;
    } else if (status == JXL_DEC_SUCCESS) {
      break;
    } else CHECK(0);
  }
  CHECK(images == 1 && memcmp(decoded, pixels, sizeof(pixels)) == 0);
  JxlDecoderDestroy(decoder);
  JxlThreadParallelRunnerDestroy(runner);
  puts("Installed JXL encoder/decoder/CMS/threads and Brotli encoder/decoder/dictionary SDK passed");
  return 0;
}
