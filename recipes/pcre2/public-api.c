#define PCRE2_CODE_UNIT_WIDTH 8
#include <pcre2.h>
#include <pcre2posix.h>
#include <stdio.h>
#include <string.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "PCRE2 SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
static int regex_sdk(void) {
  int error = 0;
  PCRE2_SIZE offset = 0;
  pcre2_code* compiled = pcre2_compile((PCRE2_SPTR)"(\\p{L}+)\\s+(\\d+)$", PCRE2_ZERO_TERMINATED,
      PCRE2_UTF | PCRE2_UCP, &error, &offset, NULL);
  CHECK(compiled);
  pcre2_match_data* matches = pcre2_match_data_create_from_pattern(compiled, NULL);
  CHECK(matches);
  const char* input = "FFB café 42";
  CHECK(pcre2_match(compiled, (PCRE2_SPTR)input, strlen(input), 0, 0, matches, NULL) == 3);
  PCRE2_UCHAR* capture = NULL;
  PCRE2_SIZE length = 0;
  CHECK(pcre2_substring_get_bynumber(matches, 1, &capture, &length) == 0);
  CHECK(length == strlen("café") && strcmp((char*)capture, "café") == 0);
  pcre2_substring_free(capture);
  pcre2_match_data_free(matches);
  pcre2_code_free(compiled);
  CHECK(!pcre2_compile((PCRE2_SPTR)"(", PCRE2_ZERO_TERMINATED, 0, &error, &offset, NULL) && error != 0);
  regex_t posix;
  CHECK(regcomp(&posix, "^FFB ([0-9]+)$", REG_EXTENDED) == 0);
  regmatch_t ranges[2];
  CHECK(regexec(&posix, "FFB 42", 2, ranges, 0) == 0);
  CHECK(ranges[1].rm_so == 4 && ranges[1].rm_eo == 6);
  regfree(&posix);
  error = regcomp(&posix, "(", REG_EXTENDED);
  CHECK(error != 0);
  char message[128];
  CHECK(regerror(error, &posix, message, sizeof(message)) > 1 && message[0]);
  puts("PCRE2: UTF/UCP captures, installed POSIX wrapper and invalid-pattern errors passed");
  return 0;
}


int main(void) { return regex_sdk(); }
