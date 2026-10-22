#include <stdint.h>
#include <xavs.h>
#include <assert.h>
#include <stdio.h>
#include <string.h>

enum { WIDTH = 64, HEIGHT = 64, FRAMES = 4 };
static unsigned collect(xavs_nal_t *nals, int count) {
    unsigned bytes = 0;
    assert(count >= 0);
    for (int i = 0; i < count; ++i) {
        assert(nals[i].i_payload > 0 && nals[i].p_payload);
        bytes += nals[i].i_payload;
    }
    return bytes;
}
int main(void) {
    assert(xavs_levels[0].level_idc > 0);
    xavs_param_t parameters;
    xavs_param_default(&parameters);
    parameters.i_width = WIDTH;
    parameters.i_height = HEIGHT;
    parameters.i_threads = 1;
    parameters.i_bframe = 0;
    parameters.i_log_level = XAVS_LOG_NONE;
    xavs_t *encoder = xavs_encoder_open(&parameters);
    assert(encoder);
    xavs_nal_t *nals = NULL;
    int count = 0;
    assert(xavs_encoder_headers(encoder, &nals, &count) >= 0);
    unsigned bytes = collect(nals, count);
    xavs_picture_t picture = {0}, output = {0};
    assert(xavs_picture_alloc(&picture, XAVS_CSP_I420, WIDTH, HEIGHT) == 0);
    for (int frame = 0; frame < FRAMES; ++frame) {
        picture.i_type = XAVS_TYPE_AUTO;
        picture.i_pts = frame;
        for (int plane = 0; plane < 3; ++plane) {
            int width = plane ? WIDTH / 2 : WIDTH;
            int height = plane ? HEIGHT / 2 : HEIGHT;
            for (int y = 0; y < height; ++y)
                for (int x = 0; x < width; ++x)
                    picture.img.plane[plane][y * picture.img.i_stride[plane] + x] = plane ? 128 : 16 + (x * 7 + y * 3 + frame * 13) % 220;
        }
        assert(xavs_encoder_encode(encoder, &nals, &count, &picture, &output) >= 0);
        bytes += collect(nals, count);
    }
    for (int iteration = 0; xavs_encoder_delayed_frames(encoder); ++iteration) {
        assert(iteration < FRAMES * 2);
        assert(xavs_encoder_encode(encoder, &nals, &count, NULL, &output) >= 0);
        bytes += collect(nals, count);
    }
    assert(bytes > 100);
    xavs_picture_clean(&picture);
    xavs_encoder_close(encoder);
    puts("Xavs: exported level data, public parameter/picture SDK, four owned frames, NALs/drain and lifetime passed");
}
