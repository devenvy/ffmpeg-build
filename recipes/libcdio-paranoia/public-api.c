#include <cdio/cdio.h>
#include <cdio/paranoia/cdda.h>
#include <cdio/paranoia/paranoia.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define CHECK(test) do { if (!(test)) { fprintf(stderr, "CDIO SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
static int paranoia_sdk(const char *cue, const char *bin) {
  CdIo_t *image = cdio_open(cue, DRIVER_BINCUE);
  CHECK(image);
  char *messages = NULL;
  cdrom_drive_t *drive = cdio_cddap_identify_cdio(image, CDDA_MESSAGE_LOGIT, &messages);
  if (messages) cdio_cddap_free_messages(messages);
  CHECK(drive && cdio_cddap_open(drive) == 0 && drive->opened);
  cdrom_paranoia_t *paranoia = cdio_paranoia_init(drive);
  CHECK(paranoia);
  cdio_paranoia_modeset(paranoia, PARANOIA_MODE_FULL ^ PARANOIA_MODE_NEVERSKIP);
  FILE *file = fopen(bin, "rb");
  CHECK(file);
  for (long sector = 0; sector < 12; sector++) {
    unsigned char expected[CDIO_CD_FRAMESIZE_RAW];
    CHECK(fread(expected, 1, sizeof(expected), file) == sizeof(expected));
    const int16_t *actual = cdio_paranoia_read_limited(paranoia, NULL, 8);
    CHECK(actual && memcmp(actual, expected, sizeof(expected)) == 0);
  }
  CHECK(cdio_paranoia_seek(paranoia, 100, SEEK_SET) >= 0);
  unsigned char expected[CDIO_CD_FRAMESIZE_RAW];
  CHECK(fseek(file, 100 * CDIO_CD_FRAMESIZE_RAW, SEEK_SET) == 0);
  CHECK(fread(expected, 1, sizeof(expected), file) == sizeof(expected));
  const int16_t *actual = cdio_paranoia_read_limited(paranoia, NULL, 8);
  CHECK(actual && memcmp(actual, expected, sizeof(expected)) == 0);
  fclose(file);
  cdio_paranoia_free(paranoia);
  CHECK(cdio_cddap_close_no_free_cdio(drive));
  cdio_destroy(image);
  puts("CDDA/paranoia: caller-owned CDIO handle, twelve verified sectors, seek to sector100 and paired lifetime passed");
  return 0;
}

int main(int argc, char **argv) {
  CHECK(argc == 3);
  return paranoia_sdk(argv[1], argv[2]);
}
