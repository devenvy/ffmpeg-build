#include <aribcaption/aribcaption.hpp>
#include <cstdio>
#include <string>
#include <utility>
#include <vector>

#define CHECK(test) do { if (!(test)) { std::fprintf(stderr, "C++ SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
int main() {
  const uint8_t management[] = {0x80,0xff,0xf0,0,0,0,0,0x0a,0x3f,1,0,0x6a,0x70,0x6e,0x80,0,0,0,0x1c,0xb0};
  const uint8_t statement[] = {0x80,0xff,0xf0,4,0,0,0,0x0f,0x3f,0,0,0x0b,0x1f,0x20,0,0,6,0x0c,0x89,0x0e,0x46,0x46,0x42,0x38,0x7f};
  aribcaption::Context original;
  aribcaption::Context context(std::move(original));
  aribcaption::Decoder decoder(context);
  CHECK(decoder.Initialize(aribcaption::EncodingScheme::kARIB_STD_B24_JIS,
      aribcaption::CaptionType::kCaption, aribcaption::Profile::kProfileA,
      aribcaption::LanguageId::kFirst));
  decoder.SetReplaceMSZFullWidthAlphanumeric(true);
  aribcaption::DecodeResult result;
  CHECK(decoder.Decode(management, sizeof(management), 0, result) == aribcaption::DecodeStatus::kNoCaption);
  CHECK(decoder.Decode(statement, sizeof(statement), 0, result) == aribcaption::DecodeStatus::kGotCaption);
  CHECK(result.caption && result.caption->text == "FFB");
  aribcaption::DecodeResult moved(std::move(result));
  CHECK(!result.caption && moved.caption);
  aribcaption::Renderer renderer(context);
  CHECK(renderer.Initialize());
  CHECK(renderer.SetFrameSize(960, 540));
  CHECK(renderer.SetDefaultFontFamily(std::vector<std::string>{"FFB Test"}, true));
  CHECK(renderer.AppendCaption(std::move(*moved.caption)));
  aribcaption::RenderResult rendered;
  CHECK(renderer.Render(0, rendered) == aribcaption::RenderStatus::kGotImage);
  CHECK(!rendered.images.empty());
  std::puts("ARIB Caption C++ SDK: context/caption ownership, vector-string font API and rendering passed");
  return 0;
}
