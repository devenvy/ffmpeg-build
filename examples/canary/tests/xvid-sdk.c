/* Owned regression fixture for public encoder timestamp and opaque ownership. */
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "libavcodec/avcodec.h"
#include "libavutil/buffer.h"
#include "libavutil/mem.h"

#define CHECK(test) do { if (!(test)) { fprintf(stderr, "Xvid encoder SDK failed line %d: %s\n", __LINE__, #test); return 1; } } while (0)
#define MAX_FRAMES 14
#define WIDTH 64
#define HEIGHT 64
#define PTS_ORIGIN 100

struct tag {
    int index;
    int *freed;
};

struct proof {
    int count;
    int packed;
    int packets;
    int bframes;
    int seen[MAX_FRAMES];
    int64_t previous_dts;
};

static void release_tag(void *opaque, uint8_t *data)
{
    struct tag *tag = (struct tag *)data;
    (void)opaque;
    (*tag->freed)++;
    av_free(data);
}

static int packets(AVCodecContext *encoder, AVPacket *packet, struct proof *proof, int flushing)
{
    for (;;) {
        int ret = avcodec_receive_packet(encoder, packet);
        if (ret == AVERROR(EAGAIN)) {
            CHECK(!flushing);
            return 0;
        }
        if (ret == AVERROR_EOF) {
            CHECK(flushing);
            return 0;
        }
        CHECK(ret == 0 && packet->size > 0);
        CHECK(packet->opaque_ref && packet->opaque_ref->size == sizeof(struct tag));
        struct tag *tag = (struct tag *)packet->opaque_ref->data;
        CHECK(tag->index >= 0 && tag->index < proof->count);
        CHECK(!proof->seen[tag->index]);
        CHECK(packet->opaque == (void *)(intptr_t)(tag->index + 1));
        CHECK(packet->pts == PTS_ORIGIN + tag->index);
        CHECK(packet->duration == 1);
        CHECK(packet->dts != AV_NOPTS_VALUE && packet->pts >= packet->dts);
        if (proof->packets)
            CHECK(packet->dts > proof->previous_dts);
        CHECK(packet->dts == PTS_ORIGIN + proof->packets - (!proof->packed && proof->bframes > 0));
        proof->previous_dts = packet->dts;
        proof->seen[tag->index] = 1;
        proof->packets++;
        av_packet_unref(packet);
    }
}

static int sequence(int count, int bframes, int global_header, int gop)
{
    const AVCodec *codec = avcodec_find_encoder_by_name("libxvid");
    CHECK(codec);
    AVCodecContext *encoder = avcodec_alloc_context3(codec);
    AVFrame *frame = av_frame_alloc();
    AVPacket *packet = av_packet_alloc();
    CHECK(encoder && frame && packet);
    int freed = 0;
    struct proof proof = { .count = count, .packed = !global_header && bframes > 0, .bframes = bframes };
    encoder->width = WIDTH;
    encoder->height = HEIGHT;
    encoder->pix_fmt = AV_PIX_FMT_YUV420P;
    encoder->time_base = (AVRational){ 1, 25 };
    encoder->framerate = (AVRational){ 25, 1 };
    encoder->sample_aspect_ratio = (AVRational){ 1, 1 };
    encoder->max_b_frames = bframes;
    encoder->gop_size = gop;
    encoder->thread_count = 1;
    encoder->flags |= AV_CODEC_FLAG_COPY_OPAQUE | AV_CODEC_FLAG_FRAME_DURATION |
                      AV_CODEC_FLAG_QSCALE | AV_CODEC_FLAG_CLOSED_GOP;
    if (global_header)
        encoder->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    CHECK(avcodec_open2(encoder, codec, NULL) == 0);
    CHECK(!global_header || encoder->extradata_size > 0);
    frame->width = WIDTH;
    frame->height = HEIGHT;
    frame->format = AV_PIX_FMT_YUV420P;
    CHECK(av_frame_get_buffer(frame, 32) == 0);
    for (int index = 0; index < count; index++) {
        CHECK(av_frame_make_writable(frame) == 0);
        for (int row = 0; row < HEIGHT; row++)
            memset(frame->data[0] + row * frame->linesize[0], 24 + index * 12, WIDTH);
        for (int plane = 1; plane < 3; plane++)
            for (int row = 0; row < HEIGHT / 2; row++)
                memset(frame->data[plane] + row * frame->linesize[plane], 128, WIDTH / 2);
        frame->pts = PTS_ORIGIN + index;
        frame->duration = 1;
        frame->quality = 4 * FF_QP2LAMBDA;
        frame->pict_type = index % gop == 0 ? AV_PICTURE_TYPE_I :
                           index % (bframes + 1) == 0 ? AV_PICTURE_TYPE_P : AV_PICTURE_TYPE_B;
        av_buffer_unref(&frame->opaque_ref);
        struct tag *tag = av_malloc(sizeof(*tag));
        CHECK(tag);
        tag->index = index;
        tag->freed = &freed;
        frame->opaque_ref = av_buffer_create((uint8_t *)tag, sizeof(*tag), release_tag, NULL, 0);
        CHECK(frame->opaque_ref);
        frame->opaque = (void *)(intptr_t)(index + 1);
        CHECK(avcodec_send_frame(encoder, frame) == 0);
        CHECK(packets(encoder, packet, &proof, 0) == 0);
    }
    CHECK(avcodec_send_frame(encoder, NULL) == 0);
    CHECK(packets(encoder, packet, &proof, 1) == 0);
    CHECK(proof.packets == count);
    for (int index = 0; index < count; index++)
        CHECK(proof.seen[index]);
    for (int repeat = 0; repeat < 3; repeat++)
        CHECK(avcodec_receive_packet(encoder, packet) == AVERROR_EOF);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&encoder);
    CHECK(freed == count);
    printf("encoder-sdk-pass frames=%d max_bframes=%d global_header=%d gop=%d packets=%d freed=%d\n",
           count, bframes, global_header, gop, proof.packets, freed);
    return 0;
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    for (int count = 1; count <= MAX_FRAMES; count++)
        for (int bframes = 0; bframes <= 3; bframes++)
            for (int global_header = 0; global_header <= 1; global_header++)
                for (int short_gop = 0; short_gop <= 1; short_gop++)
                    CHECK(sequence(count, bframes, global_header, short_gop ? 5 : 300) == 0);
    return 0;
}
