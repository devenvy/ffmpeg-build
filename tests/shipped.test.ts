import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureData } from './helpers.ts';
import { configureFlags } from '../src/build/plan.ts';
import {
  enabledOptions,
  expectedComponents,
  libraryDefaults,
  listedNames,
  roundTripCodec,
  shippedSteps,
  smokeProbes,
  smokeReport,
  staticConfigure,
  staticHas,
} from '../src/commands/shipped.ts';
import { staticShipped } from '../src/commands/test-library.ts';
import { loadEngineData, optionsOf } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';

import type { CellPlan } from '../src/resolve.ts';

const data = fixtureData();
const CONFIGURE =
  '--enable-shared --disable-gpl --enable-version3 --enable-libdav1d --enable-libopus --enable-vaapi --enable-openssl';

describe('what a build must ship', () => {
  it("reads which options a build has on from its own configure line: all of each option's --enable- flags", () => {
    expect([...enabledOptions(data, '9', 'linux-x64', CONFIGURE)].sort()).toEqual([
      'dav1d',
      'openssl',
      'opus',
      'vaapi',
    ]);
    // a flag inside another word is not the flag
    expect(enabledOptions(data, '9', 'linux-x64', '--enable-libdav1d2').size).toBe(0);
  });

  it('expects what each option on ships, where its conditions hold', () => {
    expect(expectedComponents(data, '9', 'linux-x64', CONFIGURE)).toEqual([
      { option: 'openssl', kind: 'protocols', name: 'tls' },
      { option: 'openssl', kind: 'protocols', name: 'https' },
      { option: 'dav1d', kind: 'decoders', name: 'libdav1d' },
      { option: 'vaapi', kind: 'filters', name: 'transpose_vaapi' },
      { option: 'vaapi', kind: 'hwaccels', name: 'vaapi' },
      { option: 'opus', kind: 'encoders', name: 'libopus' },
      { option: 'opus', kind: 'resamplers', name: 'soxr' }, // with dav1d on
    ]);
    // transpose_vaapi only on linux-*; soxr only with dav1d
    expect(
      expectedComponents(data, '9', 'android-arm64', '--enable-vaapi --enable-libopus').map(
        (e) => `${e.kind} ${e.name}`,
      ),
    ).toEqual(['hwaccels vaapi', 'encoders libopus']);
  });

  it('expects the components a restricted kind was built with: what components: listed must be in the build', () => {
    const configure = [
      '--disable-decoders',
      '--enable-decoder=h264,hevc',
      '--disable-muxers',
      '--enable-muxer=mp4',
      // -hwaccels lists types (vaapi), not these names: configure's own check covers them
      '--disable-hwaccels',
      '--enable-hwaccel=h264_vaapi',
      // a component asked for by name in a kind left unrestricted (a patch set's, an option's own) must be there too
      '--enable-filter=scale',
    ].join(' ');
    expect(
      expectedComponents(data, '9', 'linux-x64', configure).map((e) => [e.option, e.kind, e.name]),
    ).toEqual([
      ['components', 'decoders', 'h264'],
      ['components', 'decoders', 'hevc'],
      ['components', 'muxers', 'mp4'],
      ['components', 'filters', 'scale'],
    ]);
  });

  it('looks for each component by its own name, as the build lists it, not by configure name', () => {
    const configure = [
      '--enable-libsrt',
      '--disable-encoders',
      '--enable-encoder=libvpx_vp8,aac',
      '--disable-demuxers',
      '--enable-demuxer=mov,acme',
    ].join(' ');
    expect(
      expectedComponents(data, '9', 'linux-x64', configure, {
        demuxers: { acme: 'acme_fmt' },
      }).map((e) => `${e.option}: ${e.kind} ${e.name}`),
    ).toEqual([
      // srt ships configure's libsrt, which `ffmpeg -protocols` lists as srt
      'srt: protocols srt',
      'components: encoders libvpx',
      'components: encoders aac',
      // a format with several names: all of them, as the build lists them
      'components: demuxers mov,mp4,m4a',
      // a patch set's own name for what it adds (about.yml's listed-as)
      'components: demuxers acme_fmt',
    ]);
  });

  it("doesn't expect what an option ships in a restricted kind that left it out", () => {
    // openssl is a support library: its https and tls are only there when the target lists them
    const configure = '--enable-openssl --disable-protocols --enable-protocol=file,https';
    expect(
      expectedComponents(data, '9', 'linux-x64', configure).map((e) => `${e.option}: ${e.name}`),
    ).toEqual(['openssl: https', 'components: file']);
    // a device type (ships: hwaccels) is no hwaccel component: restricting hwaccels doesn't take it
    expect(
      expectedComponents(
        data,
        '9',
        'linux-x64',
        '--enable-vaapi --disable-hwaccels --enable-hwaccel=h264_vaapi',
      ).map((e) => `${e.kind} ${e.name}`),
    ).toEqual(['filters transpose_vaapi', 'hwaccels vaapi']);
  });

  it("reads a list as ffmpeg -buildconf records it: FFmpeg's configure quotes an argument with a comma", () => {
    const configure =
      '--disable-muxers --enable-muxer=\'mp4,matroska,null\' --disable-protocols --enable-protocol="file,pipe"';
    expect(
      expectedComponents(data, '9', 'linux-x64', configure).map((e) => `${e.kind} ${e.name}`),
    ).toEqual(['muxers mp4', 'muxers matroska', 'muxers null', 'protocols file', 'protocols pipe']);
  });

  it("asks the smoke program for a round trip, and about each component of a kind it can't list that options name", () => {
    // encoders, decoders, formats, bitstream filters, filters and protocols it lists, as ffmpeg -<kind> does
    expect(smokeProbes(data, '9')).toEqual([
      'roundtrip:mpeg4,mpeg2video,mpeg1video,ffv1,rawvideo',
      'hwaccels:vaapi',
      'resamplers:soxr',
    ]);
  });

  it("expects a build of libraries' defaults only in the kinds its components: doesn't restrict", () => {
    const names = (configure: string) =>
      libraryDefaults(data, '9', configure).map((e) => `${e.option}: ${e.kind} ${e.name}`);
    expect(names('--disable-gpl')).toEqual([
      'defaults: decoders h264',
      'defaults: decoders hevc',
      'defaults: decoders aac',
      'defaults: decoders mp3',
      'defaults: decoders flac',
      'defaults: decoders pcm_s16le',
      'defaults: decoders mjpeg',
      'defaults: muxers mp4',
      'defaults: muxers matroska',
      'defaults: muxers mpegts',
      'defaults: muxers wav',
      'defaults: muxers null',
      // by the names the build lists them under: configure's mov is mov,mp4,m4a
      'defaults: demuxers mov,mp4,m4a',
      'defaults: demuxers matroska',
      'defaults: demuxers mpegts',
      'defaults: demuxers wav',
      'defaults: bsfs h264_mp4toannexb',
      'defaults: bsfs aac_adtstoasc',
    ]);
    // a restricted kind is checked for what it listed (expectedComponents), and nothing else
    expect(
      names(
        '--disable-decoders --enable-decoder=h264 --disable-muxers --disable-demuxers --enable-demuxer=mov --disable-bsfs',
      ),
    ).toEqual([]);
  });

  it('round-trips a frame with the first codec a build has as both encoder and decoder, or none', () => {
    expect(roundTripCodec('--disable-gpl')).toBe('mpeg4');
    expect(roundTripCodec('--disable-encoders --enable-encoder=aac,mpeg4')).toBe('mpeg4');
    // the mpeg4 encoder without its decoder: the next pair
    expect(
      roundTripCodec(
        '--disable-decoders --enable-decoder=h264,ffv1 --disable-encoders --enable-encoder=mpeg4,ffv1',
      ),
    ).toBe('ffv1');
    expect(roundTripCodec("--disable-encoders --enable-encoder='aac,rawvideo'")).toBe('rawvideo');
    // decode-only
    expect(roundTripCodec('--disable-encoders')).toBeUndefined();
  });

  it("reads ffmpeg's listings: codecs and formats after the ---, filters by their pads, bare hwaccels and protocols", () => {
    const encoders = [
      'Encoders:',
      ' V..... = Video',
      ' A..... = Audio',
      ' ------',
      ' V....D libx264              libx264 H.264 / AVC (codec h264)',
      ' A....D libopus              libopus Opus (codec opus)',
    ].join('\n');
    expect([...listedNames('encoders', encoders)]).toEqual(['libx264', 'libopus']);
    const demuxers = [
      'File formats:',
      ' D.. = Demuxing supported',
      ' .E. = Muxing supported',
      ' ..d = Is a device',
      ' ---',
      ' D   dash            Dynamic Adaptive Streaming over HTTP',
      ' D  d lavfi           Libavfilter virtual input device',
      ' D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV',
    ].join('\n');
    expect([...listedNames('demuxers', demuxers)]).toEqual([
      'dash',
      'lavfi',
      'mov',
      'mp4',
      'm4a',
      '3gp',
      '3g2',
      'mj2',
    ]);
    expect(listedNames('decoders', 'no table here').size).toBe(0);
    const filters = [
      'Filters:',
      '  T.. = Timeline support',
      '  | = Source or sink filter',
      ' ... abuffer           |->A       Buffer audio frames',
      ' T.C scale_vulkan      V->V       Scale Vulkan frames',
      ' ... whisper           A->A       Transcribe audio using whisper.cpp.',
    ].join('\n');
    expect([...listedNames('filters', filters)]).toEqual(['abuffer', 'scale_vulkan', 'whisper']);
    expect([...listedNames('hwaccels', 'Hardware acceleration methods:\nvaapi\ncuda\n\n')]).toEqual(
      ['vaapi', 'cuda'],
    );
    expect([
      ...listedNames(
        'protocols',
        'Supported file protocols:\nInput:\n  file\n  https\nOutput:\n  file\n  tls\n',
      ),
    ]).toEqual(['file', 'https', 'tls']);
  });

  it('reads what the smoke program found: what it lists, and what it was asked about', () => {
    const has = smokeReport(
      [
        'smoke: lists filters whisper',
        'smoke: lists demuxers mov,mp4,m4a',
        'smoke: lists protocols tls\r',
        'smoke: lacks hwaccels vulkan',
        'smoke: has resamplers soxr',
        'smoke: ok',
      ].join('\n'),
    );
    expect(has('filters', 'whisper')).toBe(true);
    // a format by its first name, as the build lists it, or any other
    expect(has('demuxers', 'mov,mp4,m4a')).toBe(true);
    expect(has('demuxers', 'mp4')).toBe(true);
    expect(has('protocols', 'tls')).toBe(true);
    // a kind it lists, without the name: the build lacks it
    expect(has('encoders', 'libopus')).toBe(false);
    expect(has('bsfs', 'aac_adtstoasc')).toBe(false);
    expect(has('hwaccels', 'vulkan')).toBe(false);
    expect(has('resamplers', 'soxr')).toBe(true);
    expect(has('hwaccels', 'vaapi')).toBe("the smoke program didn't report it");
  });

  it('reads -bsfs as ffmpeg lists them: bare names under a heading', () => {
    expect([
      ...listedNames('bsfs', 'Bitstream filters:\naac_adtstoasc\nh264_mp4toannexb\nnull\n'),
    ]).toEqual(['aac_adtstoasc', 'h264_mp4toannexb', 'null']);
  });

  it('expects the bitstream filters a restricted kind was built with', () => {
    expect(
      expectedComponents(
        data,
        '9',
        'linux-x64',
        '--disable-bsfs --enable-bsf=h264_mp4toannexb',
      ).map((e) => `${e.option}: ${e.kind} ${e.name}`),
    ).toEqual(['components: bsfs h264_mp4toannexb']);
  });

  it('says what a build of libraries lacks of the defaults, and what it has', () => {
    const expected = [
      { option: 'defaults', kind: 'decoders', name: 'h264' },
      { option: 'defaults', kind: 'decoders', name: 'hevc' },
    ] as const;
    expect(shippedSteps(expected, () => true)).toEqual([
      { ok: true, what: 'it has decoders h264, decoders hevc' },
    ]);
    expect(shippedSteps(expected, (_, name) => name === 'h264')).toEqual([
      {
        ok: false,
        what: 'it lacks decoders hevc, which a build has unless its components: leaves it out',
      },
    ]);
  });

  it('passes an option whose components are all there, fails one that lacks any, and says what it could not check', () => {
    const expected = [
      { option: 'vulkan', kind: 'hwaccels', name: 'vulkan' },
      { option: 'vulkan', kind: 'filters', name: 'scale_vulkan' },
      { option: 'whisper', kind: 'filters', name: 'whisper' },
      { option: 'soxr', kind: 'resamplers', name: 'soxr' },
    ] as const;
    const steps = shippedSteps(expected, (kind, name) => {
      if (kind === 'resamplers') {
        return 'only running the build can tell';
      }
      return name !== 'scale_vulkan';
    });
    expect(steps).toEqual([
      {
        ok: false,
        what: 'vulkan is on, but the build lacks filters scale_vulkan',
        detail: expect.stringContaining("the configure output in the build's log") as string,
      },
      { ok: true, what: 'whisper ships filters whisper' },
      { ok: 'info', what: 'soxr: resamplers soxr not checked: only running the build can tell' },
    ]);
    expect(shippedSteps([], () => true)).toEqual([]);
  });

  it('finds a name in a library as a whole string, and tells a shared tail from it', () => {
    const lib = Buffer.from('\0junk\0scale_vulkan\0avgblur_vulkan\0libx264rgb\0');
    expect(staticHas(lib, 'scale_vulkan')).toBe(true);
    expect(staticHas(lib, 'libx264')).toBe(false);
    expect(staticHas(lib, 'blur_vulkan')).toBe('suffix');
    expect(staticHas(lib, 'whisper')).toBe(false);
  });

  it("reads a libavutil's configure line, the string with the licence flags", () => {
    const avutil = Buffer.from(
      '\x7fELF\0LGPL version 3 or later\0--prefix=/x --disable-gpl --enable-version3 --enable-vulkan\0more\0',
    );
    expect(staticConfigure(avutil)).toBe(
      '--prefix=/x --disable-gpl --enable-version3 --enable-vulkan',
    );
    expect(staticConfigure(Buffer.from('--enable-gpl --enable-libx264'))).toBe(
      '--enable-gpl --enable-libx264',
    );
    expect(staticConfigure(Buffer.from('no configure here'))).toBeUndefined();
  });

  it("looks for what a build that didn't run must ship in its libraries: Android's lib/<abi>, Apple's frameworks", () => {
    // (its kinds restricted, so the defaults are left out: the test below has them)
    const configure =
      '\0--prefix=/x --disable-gpl --enable-libdav1d --enable-libopus --disable-decoders --enable-decoder=libdav1d --disable-muxers --disable-demuxers --disable-bsfs\0';
    const android = mkdtempSync(join(tmpdir(), 'ffmpeg-build-shipped-'));
    mkdirSync(join(android, 'lib', 'arm64-v8a'), { recursive: true });
    writeFileSync(join(android, 'lib', 'arm64-v8a', 'libavutil.so'), configure);
    writeFileSync(join(android, 'lib', 'arm64-v8a', 'libavcodec.so'), '\0libdav1d\0aac\0');
    expect(staticShipped('android-arm64', android, data, '9')).toEqual([
      { ok: 'info', what: 'what it must ship: looked for by name in its libraries instead' },
      { ok: true, what: 'dav1d ships decoders libdav1d' },
      expect.objectContaining({
        ok: false,
        what: 'opus is on, but the build lacks encoders libopus',
      }) as unknown,
      { ok: 'info', what: 'opus: resamplers soxr not checked: only running the build can tell' },
    ]);
    const ios = mkdtempSync(join(tmpdir(), 'ffmpeg-build-shipped-'));
    for (const base of ['avutil', 'avcodec']) {
      mkdirSync(join(ios, `lib${base}.framework`));
    }
    writeFileSync(join(ios, 'libavutil.framework', 'libavutil'), configure);
    writeFileSync(join(ios, 'libavcodec.framework', 'libavcodec'), '\0xlibdav1d\0libopus\0');
    expect(staticShipped('ios-arm64', ios, data, '9').slice(1, 3)).toEqual([
      {
        ok: 'info',
        what: 'dav1d: decoders libdav1d not checked: libavcodec has it only as the end of a longer name, which looks the same',
      },
      { ok: true, what: 'opus ships encoders libopus' },
    ]);
    // no libavutil, or none with a configure line: nothing to go by, which is itself wrong
    expect(staticShipped('android-x64', android, data, '9')).toEqual([
      { ok: false, what: 'what it must ship not checked: no configure line in a libavutil' },
    ]);
    writeFileSync(join(ios, 'libavutil.framework', 'libavutil'), 'stripped of it');
    expect(staticShipped('ios-arm64', ios, data, '9')[0]!.what).toBe(
      'what it must ship not checked: no configure line in its libavutil',
    );
  });

  it("looks for the defaults a build that didn't run must have in its libraries, by the names it lists them under", () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-shipped-'));
    const lib = join(dir, 'lib', 'arm64-v8a');
    mkdirSync(lib, { recursive: true });
    writeFileSync(
      join(lib, 'libavutil.so'),
      '\0--disable-gpl --disable-decoders --enable-decoder=h264\0',
    );
    writeFileSync(join(lib, 'libavcodec.so'), '\0h264\0h264_mp4toannexb\0aac_adtstoasc\0');
    writeFileSync(
      join(lib, 'libavformat.so'),
      '\0mp4\0matroska\0mpegts\0wav\0null\0mov,mp4,m4a\0matroska\0',
    );
    expect(staticShipped('android-arm64', dir, data, '9').map((s) => [s.ok, s.what])).toEqual([
      ['info', 'what it must ship: looked for by name in its libraries instead'],
      [
        true,
        'it has muxers mp4, muxers matroska, muxers mpegts, muxers wav, muxers null, demuxers mov,mp4,m4a, demuxers matroska, demuxers mpegts, demuxers wav, bsfs h264_mp4toannexb, bsfs aac_adtstoasc',
      ],
      [true, 'components ships decoders h264'],
    ]);
  });

  it('reads an option as on from exactly the flags a build with it passes to configure (plan.ts)', () => {
    const engine = loadEngineData(packageRoot);
    for (const major of engine.ffmpeg.keys()) {
      for (const platform of ['linux-x64', 'win-x64', 'android-arm64', 'osx-arm64']) {
        for (const option of optionsOf(engine, major).keys()) {
          const plan = {
            cell: { major, platform, license: 'gplv3' },
            options: [option],
            recipes: [],
          };
          const flags = configureFlags(engine, plan as unknown as CellPlan).join(' ');
          expect(
            enabledOptions(engine, major, platform, flags).has(option),
            `${major} ${platform} ${option}`,
          ).toBe(true);
        }
      }
    }
  });

  it("the engine's own data: every shipped Vulkan build must have its SPIR-V filters, every TLS build https", () => {
    const engine = loadEngineData(packageRoot);
    const names = (major: string, platform: string, configure: string) =>
      expectedComponents(engine, major, platform, configure).map((e) => `${e.kind} ${e.name}`);
    expect(names('9', 'linux-x64', '--enable-vulkan --enable-libplacebo')).toEqual([
      'filters scale_vulkan',
      'hwaccels vulkan',
      'filters libplacebo',
    ]);
    // FFmpeg 8 compiles the Vulkan shaders only with libshaderc: without it, no scale_vulkan is expected
    expect(names('8', 'linux-x64', '--enable-vulkan')).toEqual(['hwaccels vulkan']);
    expect(names('8', 'linux-x64', '--enable-vulkan --enable-libshaderc')).toEqual([
      'filters scale_vulkan',
      'hwaccels vulkan',
    ]);
    expect(names('9', 'win-x64', '--enable-schannel')).toEqual([
      'protocols tls',
      'protocols https',
    ]);
    // drawtext needs harfbuzz as well as freetype
    expect(names('9', 'linux-x64', '--enable-libfreetype')).toEqual([]);
    expect(names('9', 'linux-x64', '--enable-libfreetype --enable-libharfbuzz')).toEqual([
      'filters drawtext',
    ]);
    expect(names('9', 'linux-x64', '--enable-gpl --enable-libx264 --enable-libx265')).toEqual([
      'encoders libx264',
      'encoders libx265',
    ]);
    // the nvenc option is nv-codec's five flags: all must be there
    expect(names('9', 'linux-x64', '--enable-nvenc')).toEqual([]);
  });
});
