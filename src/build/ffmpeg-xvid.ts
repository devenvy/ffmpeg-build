import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Audited complete wrappers: FFmpeg 8.0.x, 8.1.x and 9.0.x respectively.
// Preserve each release's statistics API and fallthrough annotations.
const ORIGINAL = new Set([
  'fa32aef8d77c3e0618f24684e458eb1d13024784f5bfb945e6e254c7d2453be1',
  '0e1ad41ad0e480c70732eaefb34f770d1904b6c54ba0e859b0512b175e59e7eb',
  '624a94128b20f5e9d9822c6c982253c6c62d6e938d1c08b938cfa2eb6369f88e',
]);
const FIXED = new Set([
  '565256b802d3fb71b71d793d3909ca8868c53178bf95c1c685585b2ea88f1cd0',
  'a7449b8af2b6b743501166124774aef0fff18ee541003964721e10bd03445159',
  'fe3507dc0d07ece81d080a56e32e45cb14f4aa53c66d5301f82eaf11e76f6033',
]);
const EXPECTED_PARTS = 2;
const CHANGES = [
  [
    '#include "libavutil/file_open.h"\n',
    '#include "libavutil/file_open.h"\n#include "libavutil/fifo.h"\n',
  ],
  [
    '/**\n * Structure for the private Xvid context.',
    String.raw`struct xvid_frame_info {
    int index;
    int64_t pts;
    int64_t duration;
    void *opaque;
    AVBufferRef *opaque_ref;
    struct xvid_frame_info *next;
};

/**
 * Structure for the private Xvid context.`,
  ],
  [
    '    int mpeg_quant;                /**< Quantization type. 0: H.263, 1: MPEG */\n',
    String.raw`    int mpeg_quant;                /**< Quantization type. 0: H.263, 1: MPEG */
    int packed;
    int input_index;
    int packet_index;
    int callback_index;
    int callback_count;
    int callback_type;
    int callback_quant;
    int64_t first_dts;
    struct xvid_frame_info *frames;
    AVFifo *dts;
`,
  ],
  [
    '/**\n * Structure for the private first-pass plugin.',
    String.raw`static void xvid_clear_frames(struct xvid_context *x)
{
    while (x->frames) {
        struct xvid_frame_info *frame = x->frames;
        x->frames = frame->next;
        av_buffer_unref(&frame->opaque_ref);
        av_free(frame);
    }
    av_fifo_freep2(&x->dts);
    x->input_index = x->packet_index = 0;
}

static int xvid_frame_tracking(void *handle, int operation, void *param1, void *param2)
{
    struct xvid_context *x = handle;
    xvid_plg_data_t *data = param1;

    if (operation == XVID_PLG_INFO) {
        ((xvid_plg_info_t *)param1)->flags = 0;
    } else if (operation == XVID_PLG_CREATE) {
        x = ((xvid_plg_create_t *)param1)->param;
        xvid_clear_frames(x);
        *(void **)param2 = x;
    } else if (operation == XVID_PLG_DESTROY) {
        xvid_clear_frames(x);
    } else if ((x->packed && operation == XVID_PLG_AFTER) ||
               (!x->packed && operation == XVID_PLG_FRAME)) {
        x->callback_index = data->frame_num;
        x->callback_type = data->type;
        x->callback_quant = data->quant;
        x->callback_count++;
    }
    return 0;
}

static int xvid_save_frame(AVCodecContext *avctx, const AVFrame *picture)
{
    struct xvid_context *x = avctx->priv_data;
    struct xvid_frame_info *frame = av_mallocz(sizeof(*frame));
    struct xvid_frame_info **tail = &x->frames;
    int ret;

    if (!frame)
        return AVERROR(ENOMEM);
    frame->index = x->input_index;
    frame->pts = picture->pts;
    frame->duration = picture->duration;
    if (avctx->flags & AV_CODEC_FLAG_COPY_OPAQUE) {
        frame->opaque = picture->opaque;
        if (picture->opaque_ref) {
            frame->opaque_ref = av_buffer_ref(picture->opaque_ref);
            if (!frame->opaque_ref) {
                av_free(frame);
                return AVERROR(ENOMEM);
            }
        }
    }
    if (!x->packed && avctx->max_b_frames > 0) {
        if (!x->dts)
            x->dts = av_fifo_alloc2(1, sizeof(frame->pts), AV_FIFO_FLAG_AUTO_GROW);
        ret = x->dts ? av_fifo_write(x->dts, &frame->pts, 1) : AVERROR(ENOMEM);
        if (ret < 0) {
            av_buffer_unref(&frame->opaque_ref);
            av_free(frame);
            return ret;
        }
        if (!x->input_index) {
            int64_t duration = picture->duration;
            if (duration <= 0 && avctx->framerate.num > 0)
                duration = av_rescale_q(1, av_inv_q(avctx->framerate), avctx->time_base);
            if (duration <= 0)
                duration = 1;
            x->first_dts = picture->pts == AV_NOPTS_VALUE ? AV_NOPTS_VALUE :
                           av_sat_sub64(picture->pts, duration);
        }
    }
    while (*tail)
        tail = &(*tail)->next;
    *tail = frame;
    x->input_index++;
    return 0;
}

static int xvid_packet_properties(AVCodecContext *avctx, AVPacket *pkt)
{
    struct xvid_context *x = avctx->priv_data;
    struct xvid_frame_info **entry = &x->frames;
    struct xvid_frame_info *frame;

    if (x->callback_count != 1)
        return AVERROR_BUG;
    while (*entry && (*entry)->index != x->callback_index)
        entry = &(*entry)->next;
    if (!*entry)
        return AVERROR_BUG;
    frame = *entry;
    pkt->pts = frame->pts;
    pkt->duration = frame->duration;
    pkt->dts = frame->pts;
    if (!x->packed && avctx->max_b_frames > 0) {
        if (!x->packet_index) {
            pkt->dts = x->first_dts;
        } else if (!x->dts || !av_fifo_can_read(x->dts) ||
                   av_fifo_read(x->dts, &pkt->dts, 1) < 0) {
            return AVERROR_BUG;
        }
    }
    pkt->opaque = frame->opaque;
    pkt->opaque_ref = frame->opaque_ref;
    frame->opaque_ref = NULL;
    *entry = frame->next;
    av_free(frame);
    x->packet_index++;
    return 0;
}

/**
 * Structure for the private first-pass plugin.`,
  ],
  [' * @param header_len Length of header to search\n', ''],
  ['                                 unsigned int header_len,\n', ''],
  ['    for (i = 0; i < header_len - 3; i++) {', '    for (i = 0; i + 3 < frame_len; i++) {'],
  ['    xvid_enc_plugin_t         plugins[4];', '    xvid_enc_plugin_t         plugins[5];'],
  [
    '    av_assert0(xvid_enc_create.num_plugins + (!!x->ssim) + (!!x->variance_aq) + (!!x->lumi_aq) <= FF_ARRAY_ELEMS(plugins));\n\n',
    String.raw`    x->packed = !!(xvid_enc_create.global & XVID_GLOBAL_PACKED);
    avctx->has_b_frames = avctx->max_b_frames > 0 && !x->packed;
    plugins[xvid_enc_create.num_plugins].func = xvid_frame_tracking;
    plugins[xvid_enc_create.num_plugins].param = x;
    xvid_enc_create.num_plugins++;

    av_assert0(xvid_enc_create.num_plugins <= FF_ARRAY_ELEMS(plugins));

`,
  ],
  [
    '        xvid_encode_frame(avctx, packet, picture, &got_packet);',
    '        ret = xvid_encode_frame(avctx, packet, picture, &got_packet);',
  ],
  [
    '        xvid_encore(x->encoder_handle, XVID_ENC_DESTROY, NULL, NULL);\n    }\n\n    /* Create encoder context */',
    String.raw`        xvid_encore(x->encoder_handle, XVID_ENC_DESTROY, NULL, NULL);
        x->encoder_handle = NULL;
        if (ret < 0)
            return ret;
    }

    /* Create encoder context */`,
  ],
  [
    '    xvid_enc_frame.input.csp = XVID_CSP_PLANAR; /* YUV420P */',
    '    xvid_enc_frame.input.csp = picture ? XVID_CSP_PLANAR : XVID_CSP_NULL;',
  ],
  ['    for (i = 0; i < 4; i++) {', '    for (i = 0; picture && i < 4; i++) {'],
  [
    '    xvid_enc_frame.type      =\n',
    '    xvid_enc_frame.type      = !picture ? XVID_TYPE_AUTO :\n',
  ],
  ['    if (x->qscale)\n', '    if (x->qscale && picture)\n'],
  [
    '    /* Encode */\n    xerr =',
    '    if (picture && (ret = xvid_save_frame(avctx, picture)) < 0)\n        return ret;\n    x->callback_count = 0;\n\n    /* Encode */\n    xerr =',
  ],
  [
    '        *got_packet = 1;\n',
    '        if ((ret = xvid_packet_properties(avctx, pkt)) < 0)\n            return ret;\n\n        *got_packet = 1;\n',
  ],
  ['xvid_enc_stats.type == XVID_TYPE_PVOP', 'x->callback_type == XVID_TYPE_PVOP'],
  ['xvid_enc_stats.type == XVID_TYPE_BVOP', 'x->callback_type == XVID_TYPE_BVOP'],
  ['xvid_enc_stats.type == XVID_TYPE_SVOP', 'x->callback_type == XVID_TYPE_SVOP'],
  ['xvid_enc_stats.quant * FF_QP2LAMBDA', 'x->callback_quant * FF_QP2LAMBDA'],
  [
    '        if (xvid_enc_frame.out_flags & XVID_KEYFRAME) {',
    '        pkt->size = xerr;\n\n        if (xvid_enc_frame.out_flags & XVID_KEYFRAME) {',
  ],
  [
    '                return xvid_strip_vol_header(avctx, pkt,\n                                             xvid_enc_stats.hlength, xerr);',
    '                return xvid_strip_vol_header(avctx, pkt, xerr);',
  ],
  [
    '        if (!xerr)\n            return 0;\n        av_log',
    String.raw`        if (!xerr)
            return 0;
        if (!picture && xerr == XVID_ERR_END) {
            if (x->frames || x->callback_count)
                return AVERROR_BUG;
            return AVERROR_EOF;
        }
        av_log`,
  ],
  [
    '    av_freep(&x->inter_matrix);\n\n    return 0;',
    '    av_freep(&x->inter_matrix);\n    xvid_clear_frames(x);\n\n    return 0;',
  ],
  [
    '    .p.capabilities = AV_CODEC_CAP_DR1 | AV_CODEC_CAP_ENCODER_REORDERED_OPAQUE,',
    '    .p.capabilities = AV_CODEC_CAP_DR1 | AV_CODEC_CAP_DELAY | AV_CODEC_CAP_ENCODER_REORDERED_OPAQUE,',
  ],
] as const;

/** Repair selected libxvid draining and preserve native-frame metadata; reject source drift before writing. */
export function fixXvidDelayedFrames(dir: string, flags: readonly string[]): boolean {
  if (!flags.includes('--enable-libxvid')) {
    return false;
  }
  const path = join(dir, 'libavcodec', 'libxvid.c');
  const before = `${readFileSync(path, 'utf8').replaceAll('\r\n', '\n').trimEnd()}\n`;
  const hash = createHash('sha256').update(before).digest('hex');
  if (FIXED.has(hash)) {
    return false;
  }
  if (!ORIGINAL.has(hash)) {
    throw new Error(
      'Unsupported libxvid wrapper: review source drift before applying the delayed-frame repair',
    );
  }
  let after = before;
  for (const [from, to] of CHANGES) {
    if (after.split(from).length !== EXPECTED_PARTS) {
      throw new Error('Unexpected libxvid delayed-frame repair construction');
    }
    after = after.replace(from, to);
  }
  writeFileSync(path, after);
  return true;
}
