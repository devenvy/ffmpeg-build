#include <cassert>
#include <cctype>
#include <cmath>
#include <memory>
#include <string>
#include <leptonica/allheaders.h>
#include <tesseract/baseapi.h>
#include <tesseract/capi.h>
#include <tesseract/renderer.h>
#include <tesseract/resultiterator.h>

static std::string normalized(const char *text) {
  std::string result;
  bool space = false;
  for (const unsigned char *p = reinterpret_cast<const unsigned char *>(text); *p; p++) {
    if (std::isspace(*p)) {
      space = !result.empty();
    } else {
      if (space) result += ' ';
      result += static_cast<char>(*p);
      space = false;
    }
  }
  return result;
}
struct Counts { unsigned begin{}, image{}, end{}, destroyed{}; };
class OwnedRenderer final : public tesseract::TessResultRenderer {
public:
  explicit OwnedRenderer(Counts &counts) : TessResultRenderer("-", "owned"), counts_(counts) {}
  ~OwnedRenderer() override { counts_.destroyed++; }
  std::string text;
protected:
  bool BeginDocumentHandler() override { counts_.begin++; return true; }
  bool AddImageHandler(tesseract::TessBaseAPI *api) override {
    std::unique_ptr<char[]> recognized(api->GetUTF8Text());
    if (!recognized) return false;
    text += recognized.get();
    counts_.image++;
    return true;
  }
  bool EndDocumentHandler() override { counts_.end++; return true; }
private:
  Counts &counts_;
};
int main(int argc, char **argv) {
  assert(argc == 3);
  PIX *image = pixRead(argv[1]);
  assert(image && pixGetWidth(image) == 1100 && pixGetHeight(image) == 180);
  {
    tesseract::TessBaseAPI api;
    assert(api.Init(argv[2], "eng", tesseract::OEM_LSTM_ONLY) == 0);
    api.SetPageSegMode(tesseract::PSM_SINGLE_LINE);
    api.SetImage(image);
    assert(api.Recognize(nullptr) == 0);
    {
      std::unique_ptr<tesseract::ResultIterator> iterator(api.GetIterator());
      assert(iterator);
      iterator->Begin();
      std::string words;
      do {
        std::unique_ptr<char[]> word(iterator->GetUTF8Text(tesseract::RIL_WORD));
        assert(word && word[0]);
        float confidence = iterator->Confidence(tesseract::RIL_WORD);
        assert(std::isfinite(confidence) && confidence >= 0 && confidence <= 100);
        int left, top, right, bottom;
        assert(iterator->BoundingBox(tesseract::RIL_WORD, &left, &top, &right, &bottom));
        assert(left >= 0 && top >= 0 && right > left && bottom > top && right <= 1100 && bottom <= 180);
        if (!words.empty()) words += ' ';
        words += word.get();
      } while (iterator->Next(tesseract::RIL_WORD));
      assert(normalized(words.c_str()) == "HELLO WORLD 123");
    }
    Counts counts;
    tesseract::TessResultRenderer *base = new OwnedRenderer(counts);
    auto *owned = dynamic_cast<OwnedRenderer *>(base);
    assert(owned);
    assert(base->BeginDocument("Owned OCR") && base->AddImage(&api) && base->EndDocument());
    assert(base->happy() && base->imagenum() == 0);
    assert(counts.begin == 1 && counts.image == 1 && counts.end == 1);
    assert(normalized(owned->text.c_str()) == "HELLO WORLD 123");
    delete base;
    assert(counts.destroyed == 1);
    api.End();
  }
  TessBaseAPI *api = TessBaseAPICreate();
  assert(api && TessBaseAPIInit3(api, argv[2], "eng") == 0);
  TessBaseAPISetPageSegMode(api, tesseract::PSM_SINGLE_LINE);
  TessBaseAPISetImage2(api, image);
  char *text = TessBaseAPIGetUTF8Text(api);
  assert(text && normalized(text) == "HELLO WORLD 123");
  TessDeleteText(text);
  TessBaseAPIEnd(api);
  TessBaseAPIDelete(api);
  pixDestroy(&image);
  return 0;
}
