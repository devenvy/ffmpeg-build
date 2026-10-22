#include <girepository/girepository.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "failed at line %d: %s\n", __LINE__, #condition); return 1; } } while (0)

int main(int argc, char **argv) {
  CHECK(argc == 2);
  GIRepository *repository = gi_repository_new();
  CHECK(repository != NULL);
  size_t count = 0;
  const char *const *paths = gi_repository_get_search_path(repository, &count);
  CHECK(count > 0);
  if (getenv("FFB_CHECK_PRIVATE_PATHS")) {
    for (size_t index = 0; index < count; index++) {
      CHECK(strstr(paths[index], "/opt/ffmpeg-build") == NULL);
      CHECK(strstr(paths[index], "/work/") == NULL);
    }
  }
  GError *error = NULL;
  CHECK(gi_repository_require_private(repository, argv[1], "FfbProbe", "1.0", 0, &error) != NULL);
  CHECK(error == NULL);
  GIBaseInfo *info = gi_repository_find_by_name(repository, "FfbProbe", "ANSWER");
  CHECK(info != NULL && GI_IS_CONSTANT_INFO(info));
  GIArgument value;
  CHECK(gi_constant_info_get_value(GI_CONSTANT_INFO(info), &value) == sizeof(gint));
  CHECK(value.v_int32 == 42);
  gi_constant_info_free_value(GI_CONSTANT_INFO(info), &value);
  gi_base_info_unref(info);
  CHECK(gi_repository_require_private(repository, argv[1], "FfbMissing", "1.0", 0, &error) == NULL);
  CHECK(error != NULL);
  g_clear_error(&error);
  GBytes *invalid = g_bytes_new_static("FFB invalid typelib", 19);
  CHECK(gi_typelib_new_from_bytes(invalid, &error) == NULL);
  CHECK(error != NULL);
  g_clear_error(&error);
  g_bytes_unref(invalid);
  g_object_unref(repository);
  puts("GIRepository: owned constant typelib, exact value, neutral fallback paths and missing/malformed errors passed");
  return 0;
}
