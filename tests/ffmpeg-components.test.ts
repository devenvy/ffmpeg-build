// src/ffmpeg-components.ts: the components an FFmpeg source tree has, read the way its configure reads them, and the
// lists the engine keeps per major (ffmpeg/components/<major>.yml) for `components:` to be checked against.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COMPONENT_KINDS,
  formatComponentsFile,
  parseComponentsFile,
  readComponents,
  readNeeds,
  readRuntimeNames,
} from '../src/ffmpeg-components.ts';

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-components-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

const SOURCE = {
  'libavcodec/allcodecs.c': [
    'extern const FFCodec ff_h264_decoder;',
    'extern const FFCodec ff_aac_encoder;',
    'extern const FFCodec ff_aac_decoder;',
    '// extern const FFCodec ff_commented_decoder;',
    '#if CONFIG_SOMETHING',
    'extern const FFCodec ff_libx264_encoder;',
    '#endif',
  ].join('\n'),
  'libavcodec/hwaccels.h': 'extern const struct FFHWAccel ff_h264_vaapi_hwaccel;\n',
  'libavcodec/parsers.c': 'extern const FFCodecParser ff_h264_parser;\n',
  'libavcodec/bitstream_filters.c': 'extern const FFBitStreamFilter ff_h264_mp4toannexb_bsf;\n',
  'libavformat/allformats.c': [
    'extern const FFInputFormat  ff_mov_demuxer;',
    'extern const FFOutputFormat ff_mp4_muxer;',
  ].join('\n'),
  'libavformat/protocols.c': 'extern const URLProtocol ff_file_protocol;\n',
  'libavdevice/alldevices.c': [
    'extern const FFInputFormat  ff_v4l2_demuxer;',
    'extern const FFOutputFormat ff_sdl2_muxer;',
  ].join('\n'),
  'libavfilter/allfilters.c': [
    'extern const FFFilter ff_vf_scale;',
    'extern const FFFilter ff_af_aresample;',
    'extern const FFFilter ff_vsrc_testsrc;',
    'extern const FFFilter ff_asink_anullsink;',
  ].join('\n'),
};

describe('readComponents', () => {
  it("lists each kind as FFmpeg's configure finds it, sorted", () => {
    expect(readComponents(tree(SOURCE))).toEqual({
      decoders: ['aac', 'h264'],
      encoders: ['aac', 'libx264'],
      hwaccels: ['h264_vaapi'],
      demuxers: ['mov'],
      muxers: ['mp4'],
      parsers: ['h264'],
      bsfs: ['h264_mp4toannexb'],
      protocols: ['file'],
      indevs: ['v4l2'],
      outdevs: ['sdl2'],
      filters: ['anullsink', 'aresample', 'scale', 'testsrc'],
    });
  });

  it('covers every kind a target can restrict', () => {
    expect(Object.keys(readComponents(tree(SOURCE))).sort()).toEqual([...COMPONENT_KINDS].sort());
  });

  it("writes a file that reads back as written, names YAML would mistake (FFmpeg's null muxer) included", () => {
    const c = {
      ...readComponents(tree(SOURCE)),
      muxers: ['mp4', 'null', 'true', '3g2'],
    };
    const text = formatComponentsFile('9', {
      release: '9.0.2',
      components: c,
      names: {},
      needs: {},
    });
    expect(text).toContain("  - 'null'");
    expect(parseComponentsFile(text, 'x')).toEqual({
      release: '9.0.2',
      components: c,
      names: {},
      needs: {},
    });
  });

  it('keeps the runtime names that differ and what each component needs of the options', () => {
    const f = {
      release: '9.0.2',
      components: readComponents(tree(SOURCE)),
      names: {
        encoders: { libvpx_vp8: 'libvpx', libvpx_vp9: 'libvpx-vp9' },
        demuxers: { mov: 'mov,mp4,m4a,3gp,3g2,mj2', fourxm: '4xm', zero12v: '012v' },
      },
      needs: {
        encoders: { libx264: ['libx264'] },
        filters: { scale_cuda: ['cuda_llvm|cuda_nvcc', 'ffnvcodec'] },
      },
    };
    const text = formatComponentsFile('9', f);
    expect(text).toContain('names:\n  encoders:\n    libvpx_vp8: libvpx\n');
    expect(text).toContain('    scale_cuda: [cuda_llvm|cuda_nvcc, ffnvcodec]\n');
    expect(parseComponentsFile(text, 'x')).toEqual(f);
  });

  it('refuses names: or needs: that are not maps of names', () => {
    const base = formatComponentsFile('9', {
      release: '9.0.2',
      components: readComponents(tree(SOURCE)),
      names: {},
      needs: {},
    });
    expect(() => parseComponentsFile(`${base}names: { encoders: [x] }\n`, 'c.yml')).toThrow(
      /c\.yml: names: encoders:/,
    );
    expect(() => parseComponentsFile(`${base}needs: { encoders: { x: y } }\n`, 'c.yml')).toThrow(
      /c\.yml: needs: encoders:/,
    );
  });

  it('reads each runtime name that differs from its definition, macros, headers and Objective-C included', () => {
    const files = new Map(
      Object.entries({
        ...SOURCE,
        'libavcodec/allcodecs.c': [
          'extern const FFCodec ff_h264_decoder;',
          'extern const FFCodec ff_libvpx_vp8_encoder;',
          'extern const FFCodec ff_pcm_s16le_decoder;',
          'extern const FFCodec ff_aac_latm_decoder;',
        ].join('\n'),
        'libavcodec/h264dec.c': 'const FFCodec ff_h264_decoder = {\n    .p.name = "h264",\n};',
        'libavcodec/libvpxenc.c':
          'const FFCodec ff_libvpx_vp8_encoder = {\n    .p.name = "lib" "vpx",\n    .p.long_name = "x",\n};',
        'libavcodec/pcm.c': [
          '#include "pcm.h"',
          'PCM_DECODER(S16LE, s16le, "PCM signed 16-bit little-endian");',
        ].join('\n'),
        'libavcodec/pcm.h': [
          '#define PCM_DECODER(id, name_, long_name) \\',
          '    const FFCodec ff_pcm_ ## name_ ## _decoder = { .p = { .name = #name_ } }',
        ].join('\n'),
        'libavcodec/aac/aacdec.c': '#include "aacdec_latm.h"',
        'libavcodec/aac/aacdec_latm.h':
          'const FFCodec ff_aac_latm_decoder = { .p.name = "aac_latm" };',
        'libavformat/allformats.c': 'extern const FFInputFormat  ff_mov_demuxer;\n',
        'libavformat/mov.c': 'const FFInputFormat ff_mov_demuxer = { .p.name = "mov,mp4,m4a" };',
        'libavformat/protocols.c': 'extern const URLProtocol ff_libsrt_protocol;\n',
        'libavformat/libsrt.c': 'const URLProtocol ff_libsrt_protocol = { .name = "srt" };',
        'libavdevice/alldevices.c': 'extern const FFInputFormat  ff_avfoundation_demuxer;\n',
        'libavdevice/avfoundation.m':
          'const FFInputFormat ff_avfoundation_demuxer = { .p.name = "avfoundation" };',
        'libavfilter/allfilters.c':
          'extern const FFFilter ff_vf_scale;\nextern const FFFilter ff_af_lost;',
        'libavfilter/vf_scale.c': 'const FFFilter ff_vf_scale = { .p.name = "scale" };',
      }),
    );
    expect(readRuntimeNames(files)).toEqual({
      names: {
        encoders: { libvpx_vp8: 'libvpx' },
        decoders: { pcm_s16le: 's16le' },
        demuxers: { mov: 'mov,mp4,m4a' },
        protocols: { libsrt: 'srt' },
      },
      // defined nowhere in the files given (SOURCE's bsf and a lost filter); hwaccels and parsers have no names
      unread: ['bsf h264_mp4toannexb', 'filter lost'],
    });
  });

  it("reads what each component needs of configure's options, followed through selects", () => {
    const configure = [
      'h264_vaapi_encoder_deps="VAEncPictureParameterBufferH264"',
      'h264_vaapi_encoder_select="cbs_h264 vaapi_encode"',
      'vaapi_encode_deps="vaapi"',
      'h264_nvenc_encoder_deps="nvenc"',
      'nvenc_deps="ffnvcodec"',
      'nvenc_deps_any="libdl LoadLibrary"',
      'scale_cuda_filter_deps="ffnvcodec"',
      'scale_cuda_filter_deps_any="cuda_nvcc cuda_llvm"',
      'h264_qsv_decoder_select="h264_mp4toannexb_bsf qsvdec"',
      'qsvdec_select="qsv"',
      'qsv_deps="libmfx"',
      'av1_qsv_encoder_deps="libvpl"',
      'av1_qsv_encoder_select="qsvenc"',
      'qsvenc_select="qsv"',
      'png_decoder_select="inflate_wrapper"',
      'boxblur_opencl_filter_deps="opencl gpl"',
      'inflate_wrapper_deps="zlib"',
      'loop_a_decoder_select="loop_b"',
      'loop_b_select="loop_a_decoder"',
      'enabled fontconfig        && enable libfontconfig',
      'if enabled libmfx && enabled libvpl; then',
      '   die "ERROR: can not use libmfx and libvpl together"',
      'elif enabled libvpl; then',
      '# the name of libmfx is still passed',
      '    check_pkg_config libmfx "vpl >= 2.6" "mfxvideo.h mfxdispatcher.h" MFXLoad || \\',
      '            die "ERROR: libvpl >= 2.6 not found"',
      'fi',
    ].join('\n');
    const components = {
      ...readComponents(tree(SOURCE)),
      decoders: ['h264', 'h264_qsv', 'loop_a', 'png'],
      encoders: ['av1_qsv', 'h264_nvenc', 'h264_vaapi'],
      filters: ['boxblur_opencl', 'scale', 'scale_cuda'],
    };
    const options = new Set([
      'vaapi',
      'nvenc',
      'ffnvcodec',
      'cuda_nvcc',
      'cuda_llvm',
      'libmfx',
      'libvpl',
      'zlib',
      'fontconfig',
      'libfontconfig',
      'opencl',
    ]);
    expect(readNeeds(configure, components, options)).toEqual({
      decoders: { h264_qsv: ['libmfx|libvpl'], png: ['zlib'] },
      encoders: {
        av1_qsv: ['libvpl'],
        h264_nvenc: ['ffnvcodec', 'nvenc'],
        h264_vaapi: ['vaapi'],
      },
      // configure's licence switches count: a GPL filter needs --enable-gpl
      filters: {
        boxblur_opencl: ['gpl', 'opencl'],
        scale_cuda: ['cuda_llvm|cuda_nvcc', 'ffnvcodec'],
      },
    });
  });

  it('refuses a tree that is not FFmpeg', () => {
    expect(() => readComponents(tree({ 'README.md': 'not ffmpeg' }))).toThrow(
      /libavcodec\/allcodecs\.c/,
    );
  });
});
