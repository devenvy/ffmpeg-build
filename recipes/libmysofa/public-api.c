#include <mysofa.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "SOFA SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
int main(int argc, char** argv) {
  CHECK(argc == 2);
  int error = -1;
  struct MYSOFA_HRTF* hrtf = mysofa_load(argv[1], &error);
  CHECK(hrtf && error == 0);
  CHECK(mysofa_check(hrtf) == 0 && hrtf->M == 6 && hrtf->R == 2 && hrtf->N == 32);
  mysofa_free(hrtf);
  int length = 0;
  struct MYSOFA_EASY* easy = mysofa_open_no_norm(argv[1], 48000, &length, &error);
  CHECK(easy && error == 0 && length == 32);
  float left[32], right[32], left_delay = -1, right_delay = -1;
  mysofa_getfilter_float_nointerp(easy, 1, 0, 0, left, right, &left_delay, &right_delay);
  CHECK(fabsf(left_delay) < 0.000001f && fabsf(right_delay) < 0.000001f);
  for (int i = 0; i < 32; ++i) {
    CHECK(fabsf(left[i] - (i == 0 ? .5f : 0)) < 0.000001f);
    CHECK(fabsf(right[i] - (i == 1 ? .25f : 0)) < 0.000001f);
  }
  mysofa_close(easy);
  const char invalid[] = "Authored invalid SOFA input";
  error = 0;
  hrtf = mysofa_load_data(invalid, sizeof(invalid), &error);
  CHECK(!hrtf && error != 0);
  puts("SOFA C SDK: authored HRIR metadata, exact impulse/delay and malformed input rejection passed");
  return 0;
}
