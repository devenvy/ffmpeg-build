#include <fdk-aac/aacdecoder_lib.h>
#include <fdk-aac/aacenc_lib.h>
#include <fdk-aac/genericStds.h>
#include <fdk-aac/syslib_channelMapDescr.h>
#include <stdio.h>

int main(int argc, char **argv)
{
    if (argc != 2)
        return 1;
    HANDLE_AACDECODER decoder = aacDecoder_Open(TT_MP4_ADTS, 1);
    if (!decoder)
        return 2;
    aacDecoder_Close(decoder);
    HANDLE_AACENCODER encoder = NULL;
    if (aacEncOpen(&encoder, 0, 1) != AACENC_OK)
        return 3;
    if (aacEncClose(&encoder) != AACENC_OK)
        return 4;
    unsigned char *memory = FDKcalloc(8, 1);
    if (!memory)
        return 5;
    FDKmemset(memory, 85, 8);
    FDKFILE *file = FDKfopen(argv[1], "wb+");
    if (!file || FDKfwrite(memory, 1, 8, file) != 8 || FDKfflush(file))
        return 6;
    FDKmemclear(memory, 8);
    if (FDKSEEK_SET != SEEK_SET || FDKSEEK_CUR != SEEK_CUR || FDKSEEK_END != SEEK_END)
        return 7;
    if (FDKfseek(file, 0, FDKSEEK_SET) || FDKfread(memory, 1, 8, file) != 8)
        return 8;
    for (int i = 0; i < 8; ++i) {
        if (memory[i] != 85)
            return 9;
    }
    FDKfree(memory);
    if (FDKfclose(file) || !FDK_mapInfoTabLenWg4)
        return 10;
    FDK_channelMapDescr map;
    FDK_chMapDescr_init(&map, FDK_mapInfoTabWg4, FDK_mapInfoTabLenWg4, 1);
    FDK_chMapDescr_setPassThrough(&map, 1);
    if (!FDK_chMapDescr_isValid(&map) || FDK_chMapDescr_getMapValue(&map, 0, 0) != 0)
        return 11;
    return 0;
}
