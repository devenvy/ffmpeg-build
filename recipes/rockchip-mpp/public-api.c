#define _GNU_SOURCE
#include <assert.h>
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <rockchip/rk_mpi.h>
#include <rockchip/mpp_buffer.h>
#include <rockchip/mpp_frame.h>
#include <rockchip/mpp_packet.h>
#ifdef FFB_MPP_SHARED
#include <rockchip/vpu_api.h>
#endif

int main(void) {
    unsigned char bytes[] = {0, 1, 2, 3, 4, 5, 6, 7};
    MppPacket packet = NULL, copied = NULL;
    assert(mpp_packet_init(&packet, bytes, sizeof(bytes)) == MPP_OK);
    mpp_packet_set_pos(packet, bytes + 4);
    mpp_packet_set_length(packet, 3);
    mpp_packet_set_pts(packet, 12345);
    mpp_packet_set_dts(packet, 12000);
    assert(mpp_packet_set_eos(packet) == MPP_OK && mpp_packet_get_eos(packet));
    assert(mpp_packet_copy_init(&copied, packet) == MPP_OK);
    assert(mpp_packet_get_data(copied) != bytes);
    assert(mpp_packet_get_length(copied) == 3 && mpp_packet_get_pts(copied) == 12345);
    assert(mpp_packet_get_dts(copied) == 12000 && mpp_packet_get_eos(copied));
    unsigned char expected[] = {4, 5, 6};
    bytes[4] = 99;
    assert(memcmp(mpp_packet_get_data(copied), expected, sizeof(expected)) == 0);
    assert(mpp_packet_deinit(&packet) == MPP_OK && !packet);
    assert(mpp_packet_deinit(&copied) == MPP_OK && !copied && bytes[4] == 99);

    const size_t size = 256;
    unsigned char *storage = malloc(size);
    assert(storage);
    memset(storage, 80, size);
    MppBufferGroup group = NULL;
    MppBuffer buffer = NULL;
    assert(mpp_buffer_group_get_external(&group, MPP_BUFFER_TYPE_NORMAL) == MPP_OK);
    MppBufferInfo info = {.type = MPP_BUFFER_TYPE_NORMAL, .size = size, .ptr = storage, .fd = -1};
    assert(mpp_buffer_import_with_tag(group, &info, &buffer, "ffb-sdk", __func__) == MPP_OK);
    assert(mpp_buffer_get_size(buffer) == size && mpp_buffer_get_ptr(buffer) == storage);
    assert(mpp_buffer_write(buffer, 8, expected, sizeof(expected)) == MPP_OK);
    unsigned char actual[sizeof(expected)] = {0};
    assert(mpp_buffer_read(buffer, 8, actual, sizeof(actual)) == MPP_OK);
    assert(memcmp(actual, expected, sizeof(actual)) == 0);
    MppFrame frame = NULL;
    assert(mpp_frame_init(&frame) == MPP_OK);
    mpp_frame_set_width(frame, 16);
    mpp_frame_set_height(frame, 8);
    mpp_frame_set_hor_stride(frame, 16);
    mpp_frame_set_ver_stride(frame, 8);
    mpp_frame_set_fmt(frame, MPP_FMT_YUV420SP);
    mpp_frame_set_buf_size(frame, size);
    mpp_frame_set_pts(frame, 12345);
    mpp_frame_set_buffer(frame, buffer);
    assert(mpp_packet_init_with_buffer(&packet, buffer) == MPP_OK);
    assert(mpp_packet_copy_init(&copied, packet) == MPP_OK);
    assert(mpp_buffer_put(buffer) == MPP_OK);
    assert(mpp_frame_get_width(frame) == 16 && mpp_frame_get_height(frame) == 8);
    assert(mpp_frame_get_hor_stride(frame) == 16 && mpp_frame_get_ver_stride(frame) == 8);
    assert(mpp_frame_get_fmt(frame) == MPP_FMT_YUV420SP && mpp_frame_get_pts(frame) == 12345);
    assert(mpp_frame_get_buf_size(frame) == size);
    assert(mpp_buffer_get_ptr(mpp_frame_get_buffer(frame)) == storage);
    assert(mpp_frame_deinit(&frame) == MPP_OK && !frame);
    assert(mpp_packet_deinit(&packet) == MPP_OK && !packet);
    assert(mpp_packet_get_data(copied) == storage && mpp_packet_get_size(copied) == size);
    assert(memcmp((unsigned char *)mpp_packet_get_data(copied) + 8, expected, sizeof(expected)) == 0);
    assert(mpp_packet_deinit(&copied) == MPP_OK && !copied);
    assert(mpp_buffer_group_put(group) == MPP_OK);
    assert(memcmp(storage + 8, expected, sizeof(expected)) == 0);
    free(storage);

    assert(mpp_check_support_format(MPP_CTX_DEC, MPP_VIDEO_CodingAVC) == MPP_OK);
    assert(mpp_check_support_format(MPP_CTX_DEC, MPP_VIDEO_CodingUnused) != MPP_OK);
    MppCtx context = NULL;
    MppApi *api = NULL;
    assert(mpp_create(&context, &api) == MPP_OK && context && api);
    const MPP_RET initialized = mpp_init(context, MPP_CTX_DEC, MPP_VIDEO_CodingAVC);
    assert(mpp_destroy(context) == MPP_OK);
    printf("Rockchip SDK: codec context initialization returned %d (no decode/encode claim)\n", initialized);
#ifdef FFB_MPP_SHARED
    assert(setenv("use_mpp_mode", "1", 1) == 0);
    struct VpuCodecContext *legacy = NULL;
    assert(vpu_open_context(&legacy) == 0 && legacy && legacy->vpuApiObj);
    assert(vpu_close_context(&legacy) == 0 && !legacy);
    Dl_info root, wrapper;
    /* Resolve actual definitions: a non-PIE caller can otherwise expose its canonical PLT address. */
    void *root_entry = dlsym(RTLD_DEFAULT, "mpp_create");
    void *wrapper_entry = dlsym(RTLD_DEFAULT, "vpu_open_context");
    assert(root_entry && dladdr(root_entry, &root) && strstr(root.dli_fname, "librockchip_mpp.so"));
    assert(wrapper_entry && dladdr(wrapper_entry, &wrapper) && strstr(wrapper.dli_fname, "librockchip_vpu.so"));
#endif
    puts("Rockchip SDK: frame/packet copies, imported caller-owned buffers, retained objects and cleanup passed");
    return 0;
}
