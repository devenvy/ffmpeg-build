#include <stdint.h>
#include <mz.h>
#include <mz_strm.h>
#include <mz_strm_mem.h>
#include <mz_zip.h>
#include <mz_zip_rw.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>

static const char payload[] = "Owned compressed archive SDK fixture\n";
static void read_entry(void *reader, const char *name, int bad_crc) {
    assert(mz_zip_reader_locate_entry(reader, name, 0) == MZ_OK);
    mz_zip_file *info = NULL;
    assert(mz_zip_reader_entry_get_info(reader, &info) == MZ_OK);
    assert(info && strcmp(info->filename, name) == 0);
    assert(info->uncompressed_size == sizeof(payload) - 1);
    assert(mz_zip_reader_entry_open(reader) == MZ_OK);
    char data[sizeof(payload)] = {0};
    assert(mz_zip_reader_entry_read(reader, data, sizeof(data)) == sizeof(payload) - 1);
    if (!bad_crc) assert(memcmp(data, payload, sizeof(payload) - 1) == 0);
    assert(mz_zip_reader_entry_read(reader, data, sizeof(data)) == 0);
    assert(mz_zip_reader_entry_close(reader) == (bad_crc ? MZ_CRC_ERROR : MZ_OK));
}
int main(int argc, char **argv) {
    assert(argc == 4);
    void *reader = mz_zip_reader_create();
    assert(reader && mz_zip_reader_open_file(reader, argv[1]) == MZ_OK);
    read_entry(reader, "stored.txt", 0);
    read_entry(reader, "deflated.txt", 0);
    assert(mz_zip_reader_locate_entry(reader, "missing.txt", 0) == MZ_END_OF_LIST);
    assert(mz_zip_reader_close(reader) == MZ_OK);
    assert(mz_zip_reader_open_file(reader, argv[2]) == MZ_OK);
    read_entry(reader, "stored.txt", 1);
    assert(mz_zip_reader_close(reader) == MZ_OK);
    mz_zip_reader_delete(&reader);
    assert(reader == NULL);

    void *writer = mz_zip_writer_create();
    assert(writer && mz_zip_writer_open_file(writer, argv[3], 0, 0) == MZ_OK);
    mz_zip_file info = {0};
    info.filename = "native.txt";
    info.compression_method = MZ_COMPRESS_METHOD_DEFLATE;
    assert(mz_zip_writer_add_buffer(writer, payload, sizeof(payload) - 1, &info) == MZ_OK);
    assert(mz_zip_writer_close(writer) == MZ_OK);
    mz_zip_writer_delete(&writer);
    assert(writer == NULL);
    reader = mz_zip_reader_create();
    assert(reader && mz_zip_reader_open_file(reader, argv[3]) == MZ_OK);
    read_entry(reader, "native.txt", 0);
    assert(mz_zip_reader_close(reader) == MZ_OK);
    mz_zip_reader_delete(&reader);

    void *memory = mz_stream_mem_create();
    assert(memory && mz_stream_mem_open(memory, NULL, MZ_OPEN_MODE_CREATE) == MZ_OK);
    assert(mz_stream_mem_write(memory, payload, sizeof(payload) - 1) == sizeof(payload) - 1);
    assert(mz_stream_mem_seek(memory, 6, MZ_SEEK_SET) == MZ_OK);
    assert(mz_stream_mem_tell(memory) == 6);
    char slice[10];
    assert(mz_stream_mem_read(memory, slice, sizeof(slice)) == sizeof(slice));
    assert(memcmp(slice, payload + 6, sizeof(slice)) == 0);
    assert(mz_stream_mem_close(memory) == MZ_OK);
    mz_stream_mem_delete(&memory);
    assert(memory == NULL);
    puts("Minizip: owned stored/deflated/native archives, exact reads/CRC rejection, memory seek and allocation lifetime passed");
}
