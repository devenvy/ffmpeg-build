#include <assert.h>
#include <errno.h>
#include <iconv.h>
#include <stdio.h>
#include <string.h>

static int names_seen;
static int names(unsigned count, const char *const *aliases, void *data) {
  assert(data == &names_seen && count > 0 && aliases && aliases[0]);
  names_seen += (int)count;
  return 0;
}

int main(void) {
  assert(_libiconv_version >= 0x0100);
  iconvlist(names, &names_seen);
  assert(names_seen > 0);
  iconv_t converter = iconv_open("UTF-8", "ISO-8859-15");
  assert(converter != (iconv_t)-1);
  char source[] = {'c', 'a', 'f', (char)0xe9, ' ', (char)0xa4};
  char target[32] = {0};
  char *input = source, *output = target;
  size_t left = sizeof(source), available = 1;
  errno = 0;
  assert(iconv(converter, &input, &left, &output, &available) == (size_t)-1);
  assert(errno == E2BIG && left == sizeof(source) - 1 && output == target + 1);
  available = sizeof(target) - 1;
  assert(iconv(converter, &input, &left, &output, &available) == 0);
  const unsigned char expected[] = {'c', 'a', 'f', 0xc3, 0xa9, ' ', 0xe2, 0x82, 0xac};
  assert(left == 0 && (size_t)(output - target) == sizeof(expected));
  assert(memcmp(target, expected, sizeof(expected)) == 0);
  assert(iconv(converter, NULL, NULL, NULL, NULL) == 0);
  assert(iconv_close(converter) == 0);

  converter = iconv_open("UTF-8", "UTF-8");
  assert(converter != (iconv_t)-1);
  char invalid[] = {(char)0xff}, incomplete[] = {(char)0xc3};
  input = invalid; left = sizeof(invalid); output = target; available = sizeof(target);
  errno = 0;
  assert(iconv(converter, &input, &left, &output, &available) == (size_t)-1 && errno == EILSEQ);
  input = incomplete; left = sizeof(incomplete);
  errno = 0;
  assert(iconv(converter, &input, &left, &output, &available) == (size_t)-1 && errno == EINVAL);
  assert(iconv_close(converter) == 0);
  errno = 0;
  assert(iconv_open("ffmpeg-build-invalid-encoding", "UTF-8") == (iconv_t)-1 && errno == EINVAL);
  puts("GNU iconv: public version/data/list callback, exact Latin-9 conversion, partial buffers, reset and invalid input passed");
  return 0;
}
