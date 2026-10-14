// The smoke program `ffmpeg-build test` links against a build that ships libraries and no programs (Android, iOS,
// Mac Catalyst), and runs where the platform can run (an emulator, the simulator, or this Mac). Linking proves the
// libraries have every symbol a consumer needs; running proves they load and work:
//   - it prints the version and configure line, which ffmpeg-build checks as it checks `ffmpeg -version/-buildconf`;
//   - an MPEG-4 frame encodes and decodes back to the same size (avcodec, avutil);
//   - built-in decoders, muxers, demuxers and bitstream filters every build has are registered (avformat, avcodec);
//   - a filter graph's buffer source and sink exist (avfilter); swscale and swresample answer.
// Exit 0 and "smoke: ok" on success; otherwise a "smoke: FAIL" line says what failed.
//
// Each argument `<kind>:<name>` asks whether the build has a component (ffmpeg/<major>.yml's ships:), looked up the
// way ffmpeg's own listings find it: `smoke: has <kind> <name>` or `smoke: lacks <kind> <name>`. Which of them the
// build must have, ffmpeg-build decides from the configure line printed above.
#include <stdio.h>
#include <string.h>
#include <libavcodec/avcodec.h>
#include <libavcodec/bsf.h>
#include <libavfilter/avfilter.h>
#include <libavformat/avformat.h>
#include <libavformat/avio.h>
#include <libavutil/avutil.h>
#include <libavutil/channel_layout.h>
#include <libavutil/frame.h>
#include <libavutil/hwcontext.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>

#define FAIL(...) do { printf("smoke: FAIL "); printf(__VA_ARGS__); printf("\n"); return 1; } while (0)

static int roundtrip(void) {
    const AVCodec *enc = avcodec_find_encoder(AV_CODEC_ID_MPEG4), *dec = avcodec_find_decoder(AV_CODEC_ID_MPEG4);
    if (!enc || !dec) FAIL("no mpeg4 encoder or decoder");
    AVCodecContext *ec = avcodec_alloc_context3(enc), *dc = avcodec_alloc_context3(dec);
    AVFrame *in = av_frame_alloc(), *out = av_frame_alloc();
    AVPacket *pkt = av_packet_alloc();
    if (!ec || !dc || !in || !out || !pkt) FAIL("out of memory");
    ec->width = 160; ec->height = 120; ec->pix_fmt = AV_PIX_FMT_YUV420P;
    ec->time_base = (AVRational){1, 25}; ec->framerate = (AVRational){25, 1};
    if (avcodec_open2(ec, enc, NULL) < 0) FAIL("the mpeg4 encoder doesn't open");
    in->format = ec->pix_fmt; in->width = ec->width; in->height = ec->height; in->pts = 0;
    if (av_frame_get_buffer(in, 0) < 0) FAIL("no frame buffer");
    for (int y = 0; y < in->height; y++)
        for (int x = 0; x < in->width; x++) in->data[0][y * in->linesize[0] + x] = (uint8_t)(x + y);
    for (int p = 1; p < 3; p++) memset(in->data[p], 128, (size_t)in->linesize[p] * (in->height / 2));
    if (avcodec_send_frame(ec, in) < 0 || avcodec_send_frame(ec, NULL) < 0) FAIL("the encoder refuses a frame");
    if (avcodec_receive_packet(ec, pkt) < 0) FAIL("the encoder made no packet");
    if (avcodec_open2(dc, dec, NULL) < 0) FAIL("the mpeg4 decoder doesn't open");
    if (avcodec_send_packet(dc, pkt) < 0 || avcodec_send_packet(dc, NULL) < 0) FAIL("the decoder refuses the packet");
    if (avcodec_receive_frame(dc, out) < 0) FAIL("the decoder made no frame");
    if (out->width != in->width || out->height != in->height) FAIL("decoded %dx%d, not %dx%d", out->width, out->height, in->width, in->height);
    av_packet_free(&pkt); av_frame_free(&in); av_frame_free(&out);
    avcodec_free_context(&ec); avcodec_free_context(&dc);
    printf("smoke: an mpeg4 frame encodes and decodes\n");
    return 0;
}

static int registered(void) {
    static const char *decoders[] = {"h264", "hevc", "aac", "mp3", "flac", "pcm_s16le", "mjpeg", 0};
    static const char *muxers[] = {"mp4", "matroska", "mpegts", "wav", "null", 0};
    static const char *demuxers[] = {"mp4", "matroska", "mpegts", "wav", 0};
    static const char *bsfs[] = {"h264_mp4toannexb", "aac_adtstoasc", 0};
    for (int i = 0; decoders[i]; i++) if (!avcodec_find_decoder_by_name(decoders[i])) FAIL("no %s decoder", decoders[i]);
    for (int i = 0; muxers[i]; i++) if (!av_guess_format(muxers[i], NULL, NULL)) FAIL("no %s muxer", muxers[i]);
    for (int i = 0; demuxers[i]; i++) if (!av_find_input_format(demuxers[i])) FAIL("no %s demuxer", demuxers[i]);
    for (int i = 0; bsfs[i]; i++) if (!av_bsf_get_by_name(bsfs[i])) FAIL("no %s bitstream filter", bsfs[i]);
    if (!avfilter_get_by_name("buffer") || !avfilter_get_by_name("buffersink")) FAIL("no buffer or buffersink filter");
    if (!swscale_version() || !swresample_version()) FAIL("swscale or swresample has no version");
    printf("smoke: the built-in codecs, formats, filters and bitstream filters are registered\n");
    return 0;
}

// A muxer or demuxer name can be a list ("mov,mp4,m4a"): `name` must be one of its items.
static int in_list(const char *list, const char *name) {
    size_t n = strlen(name);
    for (const char *p = list; p && *p;) {
        const char *comma = strchr(p, ',');
        size_t len = comma ? (size_t)(comma - p) : strlen(p);
        if (len == n && !strncmp(p, name, n)) return 1;
        p = comma ? comma + 1 : NULL;
    }
    return 0;
}

// Each kind is looked up as ffmpeg lists it: -hwaccels lists the device types built in (av_hwdevice_find_type_by_name
// knows every type's name, built in or not), -protocols the protocols of either direction.
static int has(const char *kind, const char *name) {
    if (!strcmp(kind, "encoders")) return avcodec_find_encoder_by_name(name) != NULL;
    if (!strcmp(kind, "decoders")) return avcodec_find_decoder_by_name(name) != NULL;
    if (!strcmp(kind, "filters")) return avfilter_get_by_name(name) != NULL;
    if (!strcmp(kind, "hwaccels")) {
        for (enum AVHWDeviceType t = AV_HWDEVICE_TYPE_NONE; (t = av_hwdevice_iterate_types(t)) != AV_HWDEVICE_TYPE_NONE;)
            if (!strcmp(av_hwdevice_get_type_name(t), name)) return 1;
        return 0;
    }
    if (!strcmp(kind, "protocols")) {
        for (int output = 0; output <= 1; output++) {
            void *it = NULL;
            for (const char *p; (p = avio_enum_protocols(&it, output));)
                if (!strcmp(p, name)) return 1;
        }
        return 0;
    }
    if (!strcmp(kind, "muxers")) {
        void *it = NULL;
        for (const AVOutputFormat *f; (f = av_muxer_iterate(&it));) if (in_list(f->name, name)) return 1;
        return 0;
    }
    if (!strcmp(kind, "demuxers")) {
        void *it = NULL;
        for (const AVInputFormat *f; (f = av_demuxer_iterate(&it));) if (in_list(f->name, name)) return 1;
        return 0;
    }
    if (!strcmp(kind, "resamplers")) {
        // swresample refuses to start a resampling engine it was built without
        SwrContext *s = NULL;
        AVChannelLayout mono = AV_CHANNEL_LAYOUT_MONO;
        int ok = swr_alloc_set_opts2(&s, &mono, AV_SAMPLE_FMT_S16, 22050, &mono, AV_SAMPLE_FMT_S16, 44100, 0, NULL) >= 0
              && av_opt_set(s, "resampler", name, 0) >= 0 && swr_init(s) >= 0;
        swr_free(&s);
        return ok;
    }
    return -1;
}

static void components(int argc, char **argv) {
    av_log_set_level(AV_LOG_QUIET); // a resampler that isn't there says so on its own
    for (int i = 1; i < argc; i++) {
        char kind[32];
        const char *colon = strchr(argv[i], ':');
        if (!colon || (size_t)(colon - argv[i]) >= sizeof kind) continue;
        memcpy(kind, argv[i], (size_t)(colon - argv[i]));
        kind[colon - argv[i]] = 0;
        int found = has(kind, colon + 1);
        if (found >= 0) printf("smoke: %s %s %s\n", found ? "has" : "lacks", kind, colon + 1);
    }
}

int main(int argc, char **argv) {
    printf("ffmpeg version %s\n", av_version_info());
    printf("configuration: %s\n", avutil_configuration());
    if (roundtrip() || registered()) return 1;
    components(argc, argv);
    printf("smoke: ok\n");
    return 0;
}
