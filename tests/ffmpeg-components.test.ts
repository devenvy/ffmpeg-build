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
    const text = formatComponentsFile('9', { release: '9.0.2', components: c });
    expect(text).toContain("  - 'null'");
    expect(parseComponentsFile(text, 'x')).toEqual({ release: '9.0.2', components: c });
  });

  it('refuses a tree that is not FFmpeg', () => {
    expect(() => readComponents(tree({ 'README.md': 'not ffmpeg' }))).toThrow(
      /libavcodec\/allcodecs\.c/,
    );
  });
});
