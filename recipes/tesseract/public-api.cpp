#include <cassert>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <leptonica/allheaders.h>
#include <tesseract/baseapi.h>
#include <tesseract/capi.h>

static size_t allocations, frees, active;
static constexpr size_t marker = 0x46464250;
union Header { std::max_align_t alignment; size_t magic; };
static void *allocate_pixels(size_t size) {
  auto *header = static_cast<Header *>(std::malloc(size + sizeof(Header)));
  assert(header);
  header->magic = marker;
  allocations++;
  active++;
  return header + 1;
}
static void free_pixels(void *pixels) {
  if (!pixels) return;
  auto *header = static_cast<Header *>(pixels) - 1;
  assert(header->magic == marker && active > 0);
  header->magic = 0;
  frees++;
  active--;
  std::free(header);
}
int main() {
  assert(std::strlen(TessVersion()) > 0);
  setPixMemoryManager(allocate_pixels, free_pixels);
  {
    tesseract::TessBaseAPI api;
    api.InitForAnalysePage();
    PIX *input = pixCreate(128, 64, 8);
    assert(input && pixSetAll(input) == 0);
    api.SetImage(input);
    pixDestroy(&input);
    PIX *thresholded = api.GetThresholdedImage();
    assert(thresholded && pixGetWidth(thresholded) == 128);
    api.Clear();
    pixDestroy(&thresholded);
    PIX *transferred = pixCreate(128, 64, 8);
    assert(transferred);
    const size_t before = active;
    api.SetInputImage(transferred);
    assert(api.GetInputImage() == transferred);
    api.End();
    assert(active < before);
  }
  TessBaseAPI *c_api = TessBaseAPICreate();
  assert(c_api);
  TessBaseAPIInitForAnalysePage(c_api);
  TessBaseAPIDelete(c_api);
  assert(allocations > 0 && frees == allocations && active == 0);
  setPixMemoryManager(std::malloc, std::free);
  return 0;
}
