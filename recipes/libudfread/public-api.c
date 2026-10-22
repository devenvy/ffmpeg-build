#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <udfread/udfread.h>
#include <udfread/blockinput.h>

static unsigned char *expected;
static size_t expected_size;
static void load_expected(const char *path) {
  FILE *source = fopen(path, "rb");
  assert(source && fseek(source, 0, SEEK_END) == 0);
  long length = ftell(source);
  assert(length > 0 && fseek(source, 0, SEEK_SET) == 0);
  expected_size = (size_t)length;
  expected = malloc(expected_size);
  assert(expected && fread(expected, 1, expected_size, source) == expected_size);
  assert(fclose(source) == 0);
}

static void udf_files(udfread *disc) {
  const char *volume = udfread_get_volume_id(disc);
  assert(volume && *volume);
  UDFDIR *directory = udfread_opendir(disc, "/BDMV/STREAM");
  assert(directory);
  struct udfread_dirent entry;
  unsigned int found = 0;
  while (udfread_readdir(directory, &entry)) {
    if (strcmp(entry.d_name, "00000.m2ts") == 0) {
      assert(entry.d_type == UDF_DT_REG);
      found++;
    }
  }
  assert(found == 1);
  udfread_rewinddir(directory);
  UDFFILE *file = udfread_file_openat(directory, "00000.m2ts");
  assert(file && udfread_file_size(file) == (int64_t)expected_size);
  unsigned char *actual = malloc(expected_size);
  assert(actual);
  assert(udfread_file_read(file, actual, expected_size) == (ssize_t)expected_size);
  assert(memcmp(actual, expected, expected_size) == 0);
  assert(udfread_file_tell(file) == (int64_t)expected_size);
  assert(udfread_file_read(file, actual, 1) == 0);
  assert(udfread_file_seek(file, -16, SEEK_END) == (int64_t)expected_size - 16);
  assert(udfread_file_read(file, actual, 16) == 16);
  assert(memcmp(actual, expected + expected_size - 16, 16) == 0);
  assert(udfread_file_lba(file, 0) > 0);
  assert(udfread_read_blocks(file, actual, 0, 2, 0) == 2);
  assert(memcmp(actual, expected, 2 * UDF_BLOCK_SIZE) == 0);
  free(actual);
  udfread_file_close(file);
  assert(!udfread_file_openat(directory, "missing.m2ts"));
  udfread_closedir(directory);
}

struct input {
  udfread_block_input api;
  FILE *file;
  unsigned int reads;
  unsigned int closes;
};
static int input_close(udfread_block_input *opaque) {
  struct input *input = (struct input *)opaque;
  input->closes++;
  int result = fclose(input->file);
  input->file = NULL;
  return result;
}
static int input_read(udfread_block_input *opaque, uint32_t lba, void *buffer, uint32_t blocks, int flags) {
  struct input *input = (struct input *)opaque;
  (void)flags;
  input->reads++;
  if (fseek(input->file, (long)lba * UDF_BLOCK_SIZE, SEEK_SET)) return -1;
  return (int)fread(buffer, UDF_BLOCK_SIZE, blocks, input->file);
}
static uint32_t input_size(udfread_block_input *opaque) {
  struct input *input = (struct input *)opaque;
  assert(fseek(input->file, 0, SEEK_END) == 0);
  long size = ftell(input->file);
  assert(size > 0 && size % UDF_BLOCK_SIZE == 0);
  return (uint32_t)(size / UDF_BLOCK_SIZE);
}
static void udf(const char *path) {
  udfread *disc = udfread_init();
  assert(disc && udfread_open(disc, path) == 0);
  udf_files(disc);
  udfread_close(disc);
  struct input input = {{input_close, input_read, input_size}, fopen(path, "rb"), 0, 0};
  assert(input.file);
  disc = udfread_init();
  assert(disc && udfread_open_input(disc, &input.api) == 0);
  udf_files(disc);
  udfread_close(disc);
  assert(input.reads > 0 && input.closes == 1 && !input.file);
  puts("UDF: image and external block callbacks, exact stream bytes, directory/file lifetime, seek/block reads and natural EOF passed");
}

int main(int argc, char **argv) {
  assert(argc == 3);
  load_expected(argv[2]);
  udf(argv[1]);
  free(expected);
  return 0;
}
