#include <cassert>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <exception>
#include <memory>
#include <sstream>
#include <string>
#include <vector>
#include <OpenColorIO/OpenColorIO.h>

namespace OCIO = OCIO_NAMESPACE;
static int log_count;
static int proxy_destroyed;
static int config_reads;
static int lut_reads;
static void logger(const char *message) {
  assert(message && std::strstr(message, "owned SDK message"));
  log_count++;
}
class OwnedProxy final : public OCIO::ConfigIOProxy {
public:
  ~OwnedProxy() override { proxy_destroyed++; }
  std::vector<uint8_t> getLutData(const char *filepath) const override {
    assert(filepath && std::strstr(filepath, "affine.cube"));
    lut_reads++;
    const std::string lut =
      "LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n"
      "0.125 0.250 0.375\n0.625 0.250 0.375\n0.125 0.750 0.375\n0.625 0.750 0.375\n"
      "0.125 0.250 0.875\n0.625 0.250 0.875\n0.125 0.750 0.875\n0.625 0.750 0.875\n";
    return {lut.begin(), lut.end()};
  }
  std::string getConfigData() const override {
    config_reads++;
    return
      "ocio_profile_version: 2\nsearch_path: luts\nstrictparsing: true\n"
      "roles: {default: source}\nfile_rules: [!<Rule> {name: Default, colorspace: source}]\n"
      "displays:\n  Owned: [!<View> {name: result, colorspace: transformed}]\n"
      "colorspaces:\n  - !<ColorSpace> {name: source, bitdepth: 32f, isdata: false, allocation: uniform}\n"
      "  - !<ColorSpace>\n    name: transformed\n    bitdepth: 32f\n    isdata: false\n    allocation: uniform\n"
      "    from_scene_reference: !<FileTransform> {src: ./affine.cube, interpolation: linear}\n";
  }
  std::string getFastLutFileHash(const char *filepath) const override {
    assert(filepath);
    return std::strstr(filepath, "affine.cube") ? "ffmpeg-build-owned-affine-v1" : "";
  }
};
static void matrix_and_callbacks(void) {
  assert(OCIO::GetVersion() && *OCIO::GetVersion());
  assert(!std::strcmp(OCIO::ROLE_SCENE_LINEAR, "scene_linear"));
  OCIO::LoggingLevel previous = OCIO::GetLoggingLevel();
  OCIO::SetLoggingLevel(OCIO::LOGGING_LEVEL_INFO);
  OCIO::SetLoggingFunction(logger);
  OCIO::LogMessage(OCIO::LOGGING_LEVEL_INFO, "owned SDK message");
  OCIO::ResetToDefaultLoggingFunction();
  OCIO::SetLoggingLevel(previous);
  assert(log_count == 1);
  OCIO::ConstConfigRcPtr config = OCIO::Config::CreateRaw();
  OCIO::MatrixTransformRcPtr transform = OCIO::MatrixTransform::Create();
  const double matrix[16] = {2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1.5, 0, 0, 0, 0, 1};
  const double offset[4] = {0.01, 0.02, 0.03, 0};
  transform->setMatrix(matrix);
  transform->setOffset(offset);
  OCIO::ConstCPUProcessorRcPtr retained;
  {
    OCIO::ConstProcessorRcPtr processor = config->getProcessor(transform);
    retained = processor->getDefaultCPUProcessor();
  }
  float rgb[3] = {0.1f, 0.2f, 0.3f};
  retained->applyRGB(rgb);
  assert(std::abs(rgb[0] - 0.21f) < 0.00001f);
  assert(std::abs(rgb[1] - 0.12f) < 0.00001f);
  assert(std::abs(rgb[2] - 0.48f) < 0.00001f);
  bool caught = false;
  try {
    config->getProcessor("missing-source", "missing-destination");
  } catch (const OCIO::Exception &error) {
    caught = true;
    assert(error.what() && *error.what());
    const std::exception *base = &error;
    assert(dynamic_cast<const OCIO::Exception *>(base) == &error);
  }
  assert(caught);
}
static void external_proxy(void) {
  {
    auto proxy = std::make_shared<OwnedProxy>();
    OCIO::ConfigIOProxyRcPtr base = proxy;
    assert(std::dynamic_pointer_cast<OwnedProxy>(base) == proxy);
    OCIO::ConstConfigRcPtr config = OCIO::Config::CreateFromConfigIOProxy(base);
    base.reset();
    proxy.reset();
    assert(proxy_destroyed == 0);
    OCIO::ConstProcessorRcPtr processor = config->getProcessor("source", "transformed");
    auto cpu = processor->getDefaultCPUProcessor();
    float rgb[3] = {0.2f, 0.4f, 0.6f};
    cpu->applyRGB(rgb);
    assert(std::abs(rgb[0] - 0.225f) < 0.00001f);
    assert(std::abs(rgb[1] - 0.45f) < 0.00001f);
    assert(std::abs(rgb[2] - 0.675f) < 0.00001f);
    assert(config_reads > 0 && lut_reads > 0);
    std::ostringstream output;
    config->serialize(output);
    assert(output.str().find("transformed") != std::string::npos);
  }
  OCIO::ClearAllCaches();
  assert(proxy_destroyed == 1);
}
int main(void) {
  matrix_and_callbacks();
  external_proxy();
  puts("OpenColorIO: public data, affine pixels, external logging/virtual config proxy, strings/vectors/streams, smart-pointer lifetimes and typed exceptions passed");
  return 0;
}
