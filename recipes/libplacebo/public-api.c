#include <assert.h>
#include <math.h>
#include <libplacebo/log.h>
#include <libplacebo/colorspace.h>
#include <libplacebo/common.h>

static unsigned messages;
static void log_message(void *context, enum pl_log_level level, const char *message) {
  assert(context == &messages && message && *message && level <= PL_LOG_INFO);
  messages++;
}
int main(void) {
  struct pl_log_params params = pl_log_default_params;
  params.log_cb = log_message;
  params.log_priv = &messages;
  params.log_level = PL_LOG_INFO;
  pl_log log = pl_log_create(PL_API_VER, &params);
  assert(log && messages > 0);
  params.log_level = PL_LOG_WARN;
  struct pl_log_params previous = pl_log_update(log, &params);
  assert(previous.log_level == PL_LOG_INFO && previous.log_cb == log_message);
  assert(previous.log_priv == &messages);
  assert(pl_log_level_update(log, PL_LOG_DEBUG) == PL_LOG_WARN);
  struct pl_color_space color = pl_color_space_unknown;
  pl_color_space_merge(&color, &pl_color_space_srgb);
  assert(color.primaries == PL_COLOR_PRIM_BT_709 && color.transfer == PL_COLOR_TRC_SRGB);
  float rgb[] = {0.1f, 0.5f, 0.9f};
  pl_color_linearize(&color, rgb);
  assert(isfinite(rgb[1]) && rgb[1] > 0 && rgb[1] < 0.5f);
  pl_color_delinearize(&color, rgb);
  assert(fabsf(rgb[0] - 0.1f) < 0.0001f && fabsf(rgb[1] - 0.5f) < 0.0001f);
  assert(fabsf(rgb[2] - 0.9f) < 0.0001f);
  pl_matrix3x3 matrix = pl_matrix3x3_identity;
  float vector[] = {1, 2, 3};
  pl_matrix3x3_scale(&matrix, 2);
  pl_matrix3x3_apply(&matrix, vector);
  assert(vector[0] == 2 && vector[1] == 4 && vector[2] == 6);
  pl_matrix3x3_invert(&matrix);
  pl_matrix3x3_apply(&matrix, vector);
  assert(vector[0] == 1 && vector[1] == 2 && vector[2] == 3);
  assert(pl_color_adjustment_neutral.brightness == 0 && pl_color_adjustment_neutral.contrast == 1);
  pl_log_destroy(&log);
  assert(!log);
  pl_log_destroy(&log);
  return 0;
}
