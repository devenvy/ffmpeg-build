#include <lensfun/lensfun.h>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>

#define CHECK(test) do { if (!(test)) { std::fprintf(stderr, "Lensfun SDK failure line %d: %s\n", __LINE__, #test); return 1; } } while (0)
int main(int argc, char** argv) {
  CHECK(argc == 2);
  std::ifstream input(argv[1]);
  const std::string xml((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
  CHECK(!xml.empty());
  lfDatabase database;
  CHECK(database.Load(xml.c_str(), xml.size()) == LF_NO_ERROR);
  const lfCamera** cameras = database.FindCameras("FFB", "Test Camera");
  CHECK(cameras && cameras[0] && !cameras[1]);
  const lfLens** lenses = database.FindLenses(cameras[0], "FFB", "Test Lens");
  CHECK(lenses && lenses[0] && !lenses[1]);
  lfModifier modifier(lenses[0], 35, 1, 160, 128, LF_PF_F32);
  CHECK(modifier.EnableDistortionCorrection() & LF_MODIFY_DISTORTION);
  float mapped[2] = {-1,-1};
  CHECK(modifier.ApplyGeometryDistortion(8, 8, 1, 1, mapped));
  CHECK(std::isfinite(mapped[0]) && std::isfinite(mapped[1]));
  CHECK(std::fabs(mapped[0] - 8) > .1f || std::fabs(mapped[1] - 8) > .1f);
  lf_free(lenses);
  lf_free(cameras);
  lfDatabase* c_database = lf_db_create();
  CHECK(c_database && lf_db_load_str(c_database, xml.c_str(), xml.size()) == LF_NO_ERROR);
  cameras = lf_db_find_cameras(c_database, "FFB", "Test Camera");
  CHECK(cameras && cameras[0]);
  lenses = lf_db_find_lenses(c_database, cameras[0], "FFB", "Test Lens", 0);
  CHECK(lenses && lenses[0]);
  lfModifier* c_modifier = lf_modifier_create(lenses[0], 35, 1, 160, 128, LF_PF_F32, false);
  CHECK(c_modifier && (lf_modifier_enable_distortion_correction(c_modifier) & LF_MODIFY_DISTORTION));
  float c_mapped[2] = {-1,-1};
  CHECK(lf_modifier_apply_geometry_distortion(c_modifier, 8, 8, 1, 1, c_mapped));
  CHECK(std::fabs(c_mapped[0] - mapped[0]) < .00001f && std::fabs(c_mapped[1] - mapped[1]) < .00001f);
  lf_modifier_destroy(c_modifier);
  lf_free(lenses);
  lf_free(cameras);
  lf_db_destroy(c_database);
  std::puts("Lensfun C/C++ SDK: authored XML database, discovery and identical nontrivial coordinate mapping passed");
  return 0;
}
