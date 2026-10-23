#include <cdio/cdio.h>
#include <cdio/ds.h>
#include <cdio/iso9660.h>
#include <cdio/udf.h>
#include <cdio/udf_file.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "CDIO SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
static int payload(const unsigned char *data) {
  for (unsigned index = 0; index < 4096; index++) CHECK(data[index] == (index * 37 + 11) % 256);
  return 0;
}
static int driver_sdk(const char *cue, const char *bin) {
  CdIo_t *image = cdio_open(cue, DRIVER_BINCUE);
  CHECK(image && cdio_get_driver_id(image) == DRIVER_BINCUE);
  CHECK(cdio_get_num_tracks(image) == 1 && cdio_get_track_lsn(image, 1) == 0);
  CHECK(cdio_get_track_format(image, 1) == TRACK_FORMAT_AUDIO);
  CHECK(CDIO_SECTOR_SYNC_HEADER[0] == 0 && CDIO_SECTOR_SYNC_HEADER[11] == 0);
  for (unsigned index = 1; index < 11; index++) CHECK(CDIO_SECTOR_SYNC_HEADER[index] == 255);
  FILE *file = fopen(bin, "rb");
  CHECK(file);
  const lsn_t sectors[] = {0, 7, 749};
  for (unsigned index = 0; index < 3; index++) {
    unsigned char expected[CDIO_CD_FRAMESIZE_RAW], actual[CDIO_CD_FRAMESIZE_RAW];
    CHECK(fseek(file, sectors[index] * CDIO_CD_FRAMESIZE_RAW, SEEK_SET) == 0);
    CHECK(fread(expected, 1, sizeof(expected), file) == sizeof(expected));
    CHECK(cdio_read_audio_sector(image, actual, sectors[index]) == DRIVER_OP_SUCCESS);
    CHECK(memcmp(actual, expected, sizeof(actual)) == 0);
  }
  fclose(file);
  cdio_destroy(image);
  puts("CDIO: owned CUE driver, track metadata, public sync-header data and exact first/middle/last audio sectors passed");
  return 0;
}
static void free_stat(void *stat) { iso9660_stat_free(stat); }
static int filesystems_sdk(const char *path) {
  iso9660_t *iso = iso9660_open(path);
  CHECK(iso);
  cdio_utf8_t *volume = NULL;
  CHECK(iso9660_ifs_get_volume_id(iso, &volume) && volume && !strcmp(volume, "FFB_TEST"));
  free(volume);
  CdioList_t *entries = iso9660_ifs_readdir(iso, "/");
  CHECK(entries && _cdio_list_length(entries) == 4);
  _cdio_list_free(entries, 1, free_stat);
  iso9660_stat_t *stat = iso9660_ifs_stat(iso, "/PAYLOAD.BIN;1");
  CHECK(stat && stat->size == 4096);
  unsigned char data[4096];
  CHECK(iso9660_iso_seek_read(iso, data, stat->lsn, 2) == sizeof(data));
  CHECK(payload(data) == 0);
  CHECK(iso9660_ifs_stat(iso, "/MISSING.BIN;1") == NULL);
  iso9660_stat_free(stat);
  CHECK(iso9660_close(iso));
  udf_t *udf = udf_open(path);
  CHECK(udf);
  udf_dirent_t *root = udf_get_root(udf, true, 0);
  CHECK(root);
  udf_dirent_t *file = udf_fopen(root, "/PAYLOAD.BIN");
  CHECK(file && udf_get_file_length(file) == sizeof(data));
  memset(data, 0, sizeof(data));
  CHECK(udf_read_block(file, data, 2) == sizeof(data));
  CHECK(payload(data) == 0);
  CHECK(udf_read_block(file, data, 1) == DRIVER_OP_ERROR);
  CHECK(udf_fopen(root, "/MISSING.BIN") == NULL);
  CHECK(udf_dirent_free(file));
  CHECK(udf_dirent_free(root));
  CHECK(udf_close(udf));
  puts("ISO9660/UDF: authored volume, exact 4096-byte file, absent paths, end-boundary rejection and paired ownership passed");
  return 0;
}

int main(int argc, char **argv) {
  CHECK(argc == 4);
  return driver_sdk(argv[1], argv[2]) || filesystems_sdk(argv[3]);
}
