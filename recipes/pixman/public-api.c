#include <pixman.h>
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static void destroyed(pixman_image_t *image, void *data) {
    (void)image;
    ++*(int *)data;
}
int main(void) {
    uint32_t source[16], destination[16];
    for (unsigned i = 0; i < 16; ++i) source[i] = 0xff000000u | (i * 0x00090703u);
    memset(destination, 0, sizeof(destination));
    pixman_image_t *src = pixman_image_create_bits(PIXMAN_a8r8g8b8, 4, 4, source, 16);
    pixman_image_t *dst = pixman_image_create_bits(PIXMAN_a8r8g8b8, 4, 4, destination, 16);
    assert(src && dst);
    int source_frees = 0, destination_frees = 0;
    pixman_image_set_destroy_function(src, destroyed, &source_frees);
    pixman_image_set_destroy_function(dst, destroyed, &destination_frees);
    assert(pixman_image_ref(src) == src);
    assert(!pixman_image_unref(src) && source_frees == 0);
    pixman_image_composite32(PIXMAN_OP_SRC, src, NULL, dst, 0, 0, 0, 0, 0, 0, 4, 4);
    assert(memcmp(source, destination, sizeof(source)) == 0);

    memset(destination, 0, sizeof(destination));
    pixman_region32_t clip;
    pixman_region32_init_rect(&clip, 1, 1, 2, 2);
    assert(pixman_image_set_clip_region32(dst, &clip));
    pixman_image_composite32(PIXMAN_OP_SRC, src, NULL, dst, 0, 0, 0, 0, 0, 0, 4, 4);
    for (int y = 0; y < 4; ++y)
        for (int x = 0; x < 4; ++x)
            assert(destination[y * 4 + x] == (x >= 1 && x < 3 && y >= 1 && y < 3 ? source[y * 4 + x] : 0));
    assert(pixman_image_set_clip_region32(dst, NULL));
    pixman_region32_fini(&clip);

    pixman_transform_t transform;
    pixman_transform_init_translate(&transform, pixman_int_to_fixed(1), 0);
    assert(pixman_image_set_transform(src, &transform));
    assert(pixman_image_set_filter(src, PIXMAN_FILTER_NEAREST, NULL, 0));
    memset(destination, 0, sizeof(destination));
    pixman_image_composite32(PIXMAN_OP_SRC, src, NULL, dst, 0, 0, 0, 0, 0, 0, 3, 4);
    for (int y = 0; y < 4; ++y)
        for (int x = 0; x < 3; ++x) assert(destination[y * 4 + x] == source[y * 4 + x + 1]);

    /* Pixman solid colors are premultiplied: half alpha has half red. */
    pixman_color_t red = {32768, 0, 0, 32768};
    pixman_image_t *solid = pixman_image_create_solid_fill(&red);
    assert(solid);
    for (int i = 0; i < 16; ++i) destination[i] = 0xff0000ffu;
    pixman_image_composite32(PIXMAN_OP_OVER, solid, NULL, dst, 0, 0, 0, 0, 0, 0, 4, 4);
    for (int i = 0; i < 16; ++i) assert(destination[i] == 0xff80007fu);
    uint32_t mask_bits[4] = {0xffffffffu, 0xffffffffu, 0xffffffffu, 0xffffffffu};
    pixman_image_t *mask = pixman_image_create_bits(PIXMAN_a8, 4, 4, mask_bits, 4);
    assert(mask);
    memset(destination, 0, sizeof(destination));
    pixman_image_composite32(PIXMAN_OP_SRC, solid, mask, dst, 0, 0, 0, 0, 0, 0, 4, 4);
    for (int i = 0; i < 16; ++i) assert(destination[i] == 0x80800000u);
    pixman_image_unref(mask);
    pixman_image_unref(solid);
    assert(pixman_image_unref(src) && source_frees == 1);
    assert(pixman_image_unref(dst) && destination_frees == 1);
    puts("Pixman: exact SRC/OVER/mask/clip/transform pixels and reference/destroy lifetime passed");
    return 0;
}
