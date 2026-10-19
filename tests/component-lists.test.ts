// src/component-lists.ts: what a target's components: builds, with what its options bring and its patch sets add.
import { describe, expect, it } from 'vitest';

import { fixtureData } from './helpers.ts';
import {
  broughtComponents,
  componentFlags,
  configureOptions,
  needsMet,
  optionConfigure,
  runtimeName,
} from '../src/component-lists.ts';
import { knownMajors, loadEngineData, optionsOf } from '../src/engine-data.ts';
import { COMPONENT_KINDS } from '../src/ffmpeg-components.ts';
import { packageRoot } from '../src/paths.ts';
import { platformMatches } from '../src/platforms.ts';

const fixture = fixtureData();
const real = loadEngineData(packageRoot);

describe('component lists', () => {
  it("reads the configure options flags turn on, and whether they meet a component's needs", () => {
    const on = configureOptions(['--enable-vaapi', '--enable-cuda-llvm', '--enable-decoder=h264']);
    expect([...on]).toEqual(['vaapi', 'cuda_llvm']);
    expect(needsMet(['vaapi'], on)).toBe(true);
    expect(needsMet(['cuda_llvm|cuda_nvcc', 'ffnvcodec'], on)).toBe(false);
    expect(needsMet(['cuda_llvm|cuda_nvcc'], on)).toBe(true);
  });

  it("gives a component's name as the build lists it, a patch set's own first", () => {
    expect(runtimeName(fixture, '9', 'protocols', 'libsrt')).toBe('srt');
    expect(runtimeName(fixture, '9', 'protocols', 'file')).toBe('file');
    expect(runtimeName(fixture, '9', 'demuxers', 'acme', { demuxers: { acme: 'acme_fmt' } })).toBe(
      'acme_fmt',
    );
    expect(runtimeName(fixture, '8', 'protocols', 'libsrt')).toBe('libsrt'); // no components file for 8
  });

  it('brings only what an auto-components option needs, its conditions met', () => {
    const t = { major: '9', platform: 'linux-x64', options: ['vaapi', 'openssl', 'opus', 'dav1d'] };
    expect(broughtComponents(fixture, t)).toEqual({
      decoders: ['libdav1d'],
      encoders: ['h264_vaapi', 'libopus'],
      hwaccels: ['h264_vaapi'],
      // transpose_vaapi is what vaapi needs and ships (on linux-*); not https or tls: openssl brings nothing
      filters: ['transpose_vaapi'],
    });
    // a GPL filter only in a build whose licence turns --enable-gpl on
    expect(broughtComponents(fixture, { ...t, license: 'gplv3' }).filters).toEqual([
      'deinterlace_vaapi',
      'transpose_vaapi',
    ]);
    // on android-arm64 vaapi's ships: entry doesn't hold, but the filter still needs only vaapi
    expect(broughtComponents(fixture, { ...t, platform: 'android-arm64' }).filters).toEqual([
      'transpose_vaapi',
    ]);
  });

  it('restricts nothing, and adds nothing, for a target without components: or patch additions', () => {
    expect(
      componentFlags(fixture, { major: '9', platform: 'linux-x64', options: ['vaapi'] }),
    ).toEqual([]);
  });
});

describe("the engine's own data", () => {
  /** What a target restricting every kind to nothing keeps, with these options on. */
  const keeps = (major: string, platform: string, options: string[]) =>
    broughtComponents(real, { major, platform, options });

  it('keeps every hardware component of an option on when a target lists that kind', () => {
    const linux = keeps('9', 'linux-x64', ['vaapi', 'nvenc', 'cuda-llvm', 'vpx']);
    expect(linux.encoders).toEqual(
      expect.arrayContaining([
        'h264_vaapi',
        'hevc_vaapi',
        'av1_vaapi',
        'h264_nvenc',
        'hevc_nvenc',
        'av1_nvenc',
        'libvpx_vp8',
        'libvpx_vp9',
      ]),
    );
    expect(linux.decoders).toEqual(expect.arrayContaining(['h264_cuvid', 'hevc_cuvid']));
    expect(linux.hwaccels).toEqual(expect.arrayContaining(['h264_vaapi', 'h264_nvdec']));
    expect(linux.filters).toEqual(expect.arrayContaining(['scale_vaapi', 'scale_cuda']));
    const win = keeps('9', 'win-x64', ['mediafoundation', 'd3d11va', 'amf', 'vpl']);
    expect(win.encoders).toEqual(
      expect.arrayContaining(['h264_mf', 'hevc_mf', 'h264_amf', 'h264_qsv', 'av1_qsv']),
    );
    expect(keeps('9', 'osx-arm64', ['videotoolbox']).encoders).toEqual(
      expect.arrayContaining(['h264_videotoolbox', 'hevc_videotoolbox', 'prores_videotoolbox']),
    );
    expect(keeps('9', 'android-arm64', ['mediacodec']).decoders).toEqual(
      expect.arrayContaining(['h264_mediacodec', 'hevc_mediacodec', 'av1_mediacodec']),
    );
    expect(keeps('9', 'linux-arm64', ['v4l2-m2m']).encoders).toEqual(
      expect.arrayContaining(['h264_v4l2m2m', 'hevc_v4l2m2m']),
    );
  });

  it('keeps no format a support library only serves: png for zlib, https for openssl, dash for xml2', () => {
    const support = keeps('9', 'linux-x64', ['zlib', 'openssl', 'xml2', 'harfbuzz']);
    expect(support).toEqual({});
  });

  it("can't miss what an option ships: every ships: entry of an auto-components option comes with it", () => {
    const missed: string[] = [];
    for (const major of knownMajors(real)) {
      const options = optionsOf(real, major);
      for (const o of [...options.values()].filter((x) => x.autoComponents)) {
        // on a platform it builds on, with what its entries need besides
        const platform = ['linux-x64', 'win-x64', 'osx-arm64', 'android-arm64'].find(
          (p) => !o.platforms || platformMatches(p, o.platforms),
        )!;
        for (const s of o.ships.filter(
          (x) => x.kind !== 'hwaccels' && (COMPONENT_KINDS as readonly string[]).includes(x.kind),
        )) {
          const brought = keeps(major, platform, [o.name, ...(s.with ?? [])]);
          const kind = s.kind as (typeof COMPONENT_KINDS)[number];
          const needs = real.components.get(major)!.needs[kind]?.[s.name];
          // every one of them needs the option: generated, not kept by hand
          const onBy = configureOptions(optionConfigure(real, o, platform));
          if (!needs?.some((n) => n.split('|').some((x) => onBy.has(x)))) {
            missed.push(`${major}: ${o.name} ships ${s.kind} ${s.name}, which doesn't need it`);
          } else if (!brought[kind]?.includes(s.name)) {
            missed.push(`${major}: ${o.name} doesn't bring ${s.kind} ${s.name}`);
          }
        }
      }
    }
    expect(missed).toEqual([]);
  });
});
