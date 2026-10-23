#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <libv4l1.h>
#include <libv4l2.h>
#include <libv4l2rds.h>
#include <libv4lconvert.h>

int main(void) {
    assert(setenv("LIBV4LCONTROL_CONTROLS", "0", 1) == 0);
    assert(v4l1_open("/ffb-owned-missing-camera", O_RDONLY) == -1 && errno == ENOENT);
    assert(v4l2_open("/ffb-owned-missing-camera", O_RDONLY) == -1 && errno == ENOENT);
    struct v4l2_rds *rds = v4l2_rds_create(0);
    assert(rds);
    v4l2_rds_reset(rds, 1);
    v4l2_rds_destroy(rds);
    assert(chdir("/") == 0);
    for (int is518 = 0; is518 < 2; is518++) {
        unsigned char source[80], output[1024];
        size_t length;
        if (is518) {
            memset(source, 0xff, 16);
            const unsigned char entropy[] = {0x28, 0xa0, 0x02, 0x8a};
            memcpy(source + 8, entropy, sizeof(entropy));
            memset(source + 16, 1, 64);
            length = 80;
        } else {
            memset(source, 0xff, 75);
            source[8] = 0x40;
            for (int block = 0; block < 12; block++) {
                source[9 + block * 3] = 0x40;
                source[10 + block * 3] = source[11 + block * 3] = 0;
            }
            length = 75;
        }
        const int width = is518 ? 16 : 32, height = is518 ? 8 : 16;
        struct v4l2_format input = {0}, format = {0};
        input.type = format.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        input.fmt.pix.width = format.fmt.pix.width = width;
        input.fmt.pix.height = format.fmt.pix.height = height;
        input.fmt.pix.pixelformat = is518 ? V4L2_PIX_FMT_OV518 : V4L2_PIX_FMT_OV511;
        format.fmt.pix.pixelformat = V4L2_PIX_FMT_YUV420;
        format.fmt.pix.bytesperline = width;
        format.fmt.pix.sizeimage = width * height * 3 / 2;
        struct v4lconvert_data *conversion = v4lconvert_create(-1);
        assert(conversion);
        for (int repeat = 0; repeat < 2; repeat++) {
            memset(output, 0, sizeof(output));
            const int count = v4lconvert_convert(conversion, &input, &format,
                                                source, length, output, sizeof(output));
            if (count != (int)format.fmt.pix.sizeimage) {
                fprintf(stderr, "%s\n", v4lconvert_get_error_message(conversion));
                v4lconvert_destroy(conversion);
                return 1;
            }
            assert(count == (int)format.fmt.pix.sizeimage);
            for (int i = 0; i < count; i++)
                assert(output[i] == 128);
        }
        v4lconvert_destroy(conversion);
    }
    puts("V4L: native public libraries, two independent decoder processes, exact authored conversions and cleanup passed");
    return 0;
}
