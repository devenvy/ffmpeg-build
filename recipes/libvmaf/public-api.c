#include <libvmaf/libvmaf.h>
#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

enum { WIDTH = 192, HEIGHT = 128, FRAMES = 6 };
static double measure(int degraded) {
    VmafContext *context = NULL;
    VmafConfiguration config = {.log_level = VMAF_LOG_LEVEL_ERROR, .n_threads = 1, .n_subsample = 1};
    assert(vmaf_init(&context, config) == 0 && context);
    VmafModel *model = NULL;
    VmafModelConfig model_config = {.name = "owned", .flags = VMAF_MODEL_FLAGS_DEFAULT};
    assert(vmaf_model_load(&model, &model_config, "vmaf_v0.6.1") == 0 && model);
    assert(vmaf_use_features_from_model(context, model) == 0);
    for (unsigned frame = 0; frame < FRAMES; ++frame) {
        VmafPicture reference = {0}, distorted = {0};
        assert(vmaf_picture_alloc(&reference, VMAF_PIX_FMT_YUV420P, 8, WIDTH, HEIGHT) == 0);
        assert(vmaf_picture_alloc(&distorted, VMAF_PIX_FMT_YUV420P, 8, WIDTH, HEIGHT) == 0);
        for (int plane = 0; plane < 3; ++plane) {
            for (unsigned y = 0; y < reference.h[plane]; ++y) {
                for (unsigned x = 0; x < reference.w[plane]; ++x) {
                    uint8_t value = plane ? 128 : 16 + ((x * 13 + y * 7 + frame * 11) % 220);
                    ((uint8_t *)reference.data[plane])[y * reference.stride[plane] + x] = value;
                    ((uint8_t *)distorted.data[plane])[y * distorted.stride[plane] + x] = degraded ? 128 : value;
                }
            }
        }
        /* Successful read transfers both picture references to the context. */
        assert(vmaf_read_pictures(context, &reference, &distorted, frame) == 0);
    }
    assert(vmaf_read_pictures(context, NULL, NULL, 0) == 0);
    double sum = 0;
    for (unsigned frame = 0; frame < FRAMES; ++frame) {
        double score;
        assert(vmaf_score_at_index(context, model, &score, frame) == 0);
        assert(isfinite(score) && score >= 0 && score <= 100.00001);
        sum += score;
    }
    double pooled;
    assert(vmaf_score_pooled(context, model, VMAF_POOL_METHOD_MEAN, &pooled, 0, FRAMES - 1) == 0);
    assert(fabs(pooled - sum / FRAMES) < 0.00001);
    assert(vmaf_close(context) == 0);
    vmaf_model_destroy(model);
    return pooled;
}
int main(void) {
    assert(vmaf_version() && strlen(vmaf_version()) > 0);
    double identical = measure(0), degraded = measure(1);
    assert(identical > 90 && identical > degraded + 1);
    printf("VMAF: six owned picture pairs, built-in model, finite per-frame/pooled scores, ownership and degradation ordering passed (%g > %g)\n", identical, degraded);
}
