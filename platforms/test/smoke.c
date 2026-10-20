// The smoke program `ffmpeg-build test` links against a build that ships libraries and no programs (Android, iOS,
// Mac Catalyst), and runs where the platform can run (an emulator, the simulator, or this Mac). Linking proves the
// libraries have every symbol a consumer needs; running proves they load and work:
//   - it prints the version and configure line, which ffmpeg-build checks as it checks `ffmpeg -version/-buildconf`;
//   - every library answers, and a filter graph's buffer source and sink exist (every build has these);
//   - `roundtrip:a,b,...`: a frame of the first of these codecs the build has as encoder and decoder encodes and
//     decodes back to the same size (avcodec, avutil), or `smoke: no round trip` when it has none of them;
//   - it lists what the build registered, as ffmpeg's -encoders, -decoders, -muxers, -demuxers, -bsfs, -protocols and
//     -filters do: `smoke: lists <kind> <name>`.
// Exit 0 and "smoke: ok" on success; otherwise a "smoke: FAIL" line says what failed.
//
// Each argument `<kind>:<name>` asks whether the build has a component of a kind no listing shows (hwaccels: the
// device types built in; resamplers): `smoke: has <kind> <name>` or `smoke: lacks <kind> <name>`. What the build must
// have, and which codec it must have made the round trip with, ffmpeg-build decides from the configure line printed
// above: a slim build (components:) is asked only for what it was built with.
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

// What every build has, whatever its components: the libraries answer, and a filter graph's ends are there (configure
// builds the buffer and buffersink filters into every libavfilter, outside the filter list a build restricts).
static int basics(void) {
    if (!avformat_version() || !avcodec_version() || !avfilter_version()) FAIL("a library has no version");
    if (!swscale_version() || !swresample_version()) FAIL("swscale or swresample has no version");
    if (!avfilter_get_by_name("buffer") || !avfilter_get_by_name("buffersink")) FAIL("no buffer or buffersink filter");
    printf("smoke: the libraries load and answer\n");
    return 0;
}

// A frame of codec `name` encodes and decodes back to the same size. The decoder gets what a demuxer would hand it:
// the encoder's parameters (its size and format, which rawvideo needs, and its headers).
static int roundtrip(const char *name) {
    const AVCodec *enc = avcodec_find_encoder_by_name(name), *dec = avcodec_find_decoder_by_name(name);
    AVCodecContext *ec = avcodec_alloc_context3(enc), *dc = avcodec_alloc_context3(dec);
    AVCodecParameters *par = avcodec_parameters_alloc();
    AVFrame *in = av_frame_alloc(), *out = av_frame_alloc();
    AVPacket *pkt = av_packet_alloc();
    if (!ec || !dc || !par || !in || !out || !pkt) FAIL("out of memory");
    ec->width = 160; ec->height = 120; ec->pix_fmt = AV_PIX_FMT_YUV420P;
    ec->time_base = (AVRational){1, 25}; ec->framerate = (AVRational){25, 1};
    if (avcodec_open2(ec, enc, NULL) < 0) FAIL("the %s encoder doesn't open", name);
    in->format = ec->pix_fmt; in->width = ec->width; in->height = ec->height; in->pts = 0;
    if (av_frame_get_buffer(in, 0) < 0) FAIL("no frame buffer");
    for (int y = 0; y < in->height; y++)
        for (int x = 0; x < in->width; x++) in->data[0][y * in->linesize[0] + x] = (uint8_t)(x + y);
    for (int p = 1; p < 3; p++) memset(in->data[p], 128, (size_t)in->linesize[p] * (in->height / 2));
    if (avcodec_send_frame(ec, in) < 0 || avcodec_send_frame(ec, NULL) < 0) FAIL("the %s encoder refuses a frame", name);
    if (avcodec_receive_packet(ec, pkt) < 0) FAIL("the %s encoder made no packet", name);
    if (avcodec_parameters_from_context(par, ec) < 0 || avcodec_parameters_to_context(dc, par) < 0)
        FAIL("the %s encoder's parameters don't pass to its decoder", name);
    if (avcodec_open2(dc, dec, NULL) < 0) FAIL("the %s decoder doesn't open", name);
    if (avcodec_send_packet(dc, pkt) < 0 || avcodec_send_packet(dc, NULL) < 0) FAIL("the %s decoder refuses the packet", name);
    if (avcodec_receive_frame(dc, out) < 0) FAIL("the %s decoder made no frame", name);
    if (out->width != in->width || out->height != in->height)
        FAIL("%s decoded %dx%d, not %dx%d", name, out->width, out->height, in->width, in->height);
    av_packet_free(&pkt); av_frame_free(&in); av_frame_free(&out); avcodec_parameters_free(&par);
    avcodec_free_context(&ec); avcodec_free_context(&dc);
    printf("smoke: a %s frame encodes and decodes\n", name);
    return 0;
}

// `roundtrip:a,b,c`: the first of these the build has as both encoder and decoder, looked up by name (no hardware
// codec stands in), makes the round trip; a failure in it fails the program.
static int roundtrip_first(const char *list) {
    char name[64];
    for (const char *p = list; p && *p;) {
        const char *comma = strchr(p, ',');
        size_t len = comma ? (size_t)(comma - p) : strlen(p);
        if (len && len < sizeof name) {
            memcpy(name, p, len);
            name[len] = 0;
            if (avcodec_find_encoder_by_name(name) && avcodec_find_decoder_by_name(name)) return roundtrip(name);
        }
        p = comma ? comma + 1 : NULL;
    }
    printf("smoke: no round trip\n");
    return 0;
}

// What the build registered, kind by kind, by the names ffmpeg's listings show (a format's whole "mov,mp4,m4a").
static void listings(void) {
    void *it = NULL;
    for (const AVCodec *c; (c = av_codec_iterate(&it));)
        printf("smoke: lists %s %s\n", av_codec_is_encoder(c) ? "encoders" : "decoders", c->name);
    it = NULL;
    for (const AVOutputFormat *f; (f = av_muxer_iterate(&it));) printf("smoke: lists muxers %s\n", f->name);
    it = NULL;
    for (const AVInputFormat *f; (f = av_demuxer_iterate(&it));) printf("smoke: lists demuxers %s\n", f->name);
    it = NULL;
    for (const AVBitStreamFilter *b; (b = av_bsf_iterate(&it));) printf("smoke: lists bsfs %s\n", b->name);
    it = NULL;
    for (const AVFilter *f; (f = av_filter_iterate(&it));) printf("smoke: lists filters %s\n", f->name);
    for (int output = 0; output <= 1; output++) {
        it = NULL;
        for (const char *p; (p = avio_enum_protocols(&it, output));) printf("smoke: lists protocols %s\n", p);
    }
}

// The kinds no listing shows: -hwaccels lists the device types built in (av_hwdevice_find_type_by_name knows every
// type's name, built in or not); a resampler is there when swresample starts it.
static int has(const char *kind, const char *name) {
    if (!strcmp(kind, "hwaccels")) {
        for (enum AVHWDeviceType t = AV_HWDEVICE_TYPE_NONE; (t = av_hwdevice_iterate_types(t)) != AV_HWDEVICE_TYPE_NONE;)
            if (!strcmp(av_hwdevice_get_type_name(t), name)) return 1;
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
    if (basics()) return 1;
    for (int i = 1; i < argc; i++)
        if (!strncmp(argv[i], "roundtrip:", 10) && roundtrip_first(argv[i] + 10)) return 1;
    listings();
    components(argc, argv);
    printf("smoke: ok\n");
    return 0;
}
