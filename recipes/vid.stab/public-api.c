#include <vid.stab/libvidstab.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "Vid.stab SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
static unsigned log_count;
static int log_message(int type, const char* tag, const char* format, ...) {
  (void)type; (void)tag; (void)format;
  ++log_count;
  return 0;
}
int main(void) {
  CHECK(vs_malloc && vs_realloc && vs_free && vs_zalloc && vs_strdup && vs_log);
  const int saved_level = vs_log_level;
  const vs_log_t saved_log = vs_log;
  vs_log_level = VS_INFO_TYPE;
  vs_log = log_message;
  vs_log(VS_INFO_TYPE, "ffb-sdk", "authored public logging callback");
  CHECK(log_count == 1 && VS_ERROR != VS_OK);
  void* allocation = vs_malloc(128);
  CHECK(allocation);
  memset(allocation, 37, 128);
  allocation = vs_realloc(allocation, 256);
  CHECK(allocation && ((unsigned char*)allocation)[127] == 37);
  vs_free(allocation);
  char* copy = vs_strdup("authored SDK string");
  CHECK(copy && strcmp(copy, "authored SDK string") == 0);
  vs_free(copy);
  allocation = vs_zalloc(128);
  CHECK(allocation);
  for (size_t index = 0; index < 128; ++index) CHECK(((unsigned char*)allocation)[index] == 0);
  vs_free(allocation);
  VSFrameInfo info;
  CHECK(vsFrameInfoInit(&info, 160, 128, PF_GRAY8) == 1);
  VSFrame frame;
  vsFrameNull(&frame);
  vsFrameAllocate(&frame, &info);
  CHECK(frame.data[0] && frame.linesize[0] >= 160);
  VSMotionDetectConfig config = vsMotionDetectGetDefaultConfig("ffb-sdk");
  VSMotionDetect detector;
  CHECK(vsMotionDetectInit(&detector, &config, &info) == VS_OK);
  vsMotionDetectionCleanup(&detector);
  vsFrameFree(&frame);
  vs_log = saved_log;
  vs_log_level = saved_level;
  puts("Vid.stab C SDK: writable logging/allocator globals, frame and detector APIs passed");
  return 0;
}
