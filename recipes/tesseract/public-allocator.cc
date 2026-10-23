#include <tesseract/baseapi.h>
#include <cstring>
#include "allocator-support.h"
static int exercise_public_allocator(int argc, char **argv) {
    begin_allocator_tracking();
    tesseract::TessBaseAPI api;
    api.InitForAnalysePage();
    allocator_tracking = false;
    if (argc < 2) return 0;
    if (api.Init(argv[1], "eng", tesseract::OEM_LSTM_ONLY)) return 3;
    unsigned char image[64 * 32];
    std::memset(image, 255, sizeof(image));
    api.SetImage(image, 64, 32, 1, 64);
    begin_allocator_tracking();
    char *text = api.GetUTF8Text();
    allocator_tracking = false;
    const bool owned = text && allocator_registered(text);
    delete[] text;
    api.End();
    return owned ? 0 : 4;
}
