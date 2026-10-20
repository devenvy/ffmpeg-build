// Whether a build has what its configure line asked for. Each option's `ships:` in ffmpeg/<major>.yml names what a
// build with it on must report; `ffmpeg-build test` checks those against the build itself: what `ffmpeg -encoders`,
// `-filters`, `-hwaccels`, ... list, or, for a build of libraries, what the smoke program finds through the libraries'
// own lookups. Configure taking an option proves only that it was asked for: FFmpeg drops a component whose own needs
// aren't met without a word (FFmpeg 8.1.2's Vulkan builds shipped with no Vulkan filters, from a glslc too old), and
// this is what catches it. Expectations come from the build's own configure line, so nothing is kept per target.
import { optionConfigure, runtimeName } from '../component-lists.ts';
import { type EngineData, optionsOf } from '../engine-data.ts';
import {
  COMPONENT_FLAG,
  COMPONENT_KINDS,
  type ComponentKind,
  type RuntimeNames,
} from '../ffmpeg-components.ts';
import { platformMatches } from '../platforms.ts';
import { SHIPPED_KINDS, type ShippedKind } from '../schema/engine.ts';

import type { Step } from './test-library.ts';

/**
 * A component the build must have: `kind` is the list it is in (ffmpeg -<kind>), `option` the option that adds it,
 * `name` the name the build lists it by (a format with several: all of them, `mov,mp4,m4a`).
 */
export interface Expected {
  option: string;
  kind: ShippedKind;
  name: string;
}

/** Whether the build has a component: true or false, or why that can't be told here. */
export type Has = (kind: ShippedKind, name: string) => boolean | string;

/** The name a listing or a lookup finds a component by: a format's first (`mov` of `mov,mp4,m4a`). */
export const listedAs = (name: string): string => name.split(',')[0]!;

const words = (configure: string): Set<string> => new Set(configure.split(/\s+/).filter(Boolean));

/** The options of FFmpeg `major` this configure line has on: every one of its own --enable- flags is there. */
export function enabledOptions(
  data: EngineData,
  major: string,
  platform: string,
  configure: string,
): Set<string> {
  const flags = words(configure);
  return new Set(
    [...optionsOf(data, major).values()]
      .filter((info) => {
        const enables = optionConfigure(data, info, platform).filter((f) =>
          f.startsWith('--enable-'),
        );
        return enables.length > 0 && enables.every((f) => flags.has(f));
      })
      .map((info) => info.name),
  );
}

/** The components kinds a build lists by name (not hwaccels: -hwaccels lists device types). */
const LISTED_KINDS = COMPONENT_KINDS.filter(
  (k): k is ComponentKind & ShippedKind =>
    k !== 'hwaccels' && (SHIPPED_KINDS as readonly string[]).includes(k),
);
const isComponentKind = (k: string): k is ComponentKind =>
  (COMPONENT_KINDS as readonly string[]).includes(k);

/**
 * The names configure was asked for in one kind (`--enable-decoder=h264,hevc`), as -buildconf records the list:
 * configure quotes one with a comma (`--enable-muxer='mp4,null'`).
 */
const askedFor = (flags: readonly string[], kind: ComponentKind): string[] =>
  flags
    .filter((f) => f.startsWith(`--enable-${COMPONENT_FLAG[kind]}=`))
    .flatMap((f) =>
      f
        .slice(f.indexOf('=') + 1)
        .replace(/^(['"])(.*)\1$/, '$2')
        .split(','),
    )
    .filter(Boolean);

/**
 * Whether a build with these configure flags has a component configure knows by `name`: in a kind the target
 * restricted (components: is `--disable-<kind>` and `--enable-<kind>=<names>`, all the engine passes), only one asked
 * for; in any other kind, every component whose needs are met, so all the ones needing nothing.
 */
const inBuild = (flags: readonly string[], kind: ComponentKind, name: string): boolean =>
  !flags.includes(`--disable-${kind}`) || askedFor(flags, kind).includes(name);

/**
 * What a build of FFmpeg `major` for `platform` with this configure line must have: what each option on ships, and
 * every component configure was asked for by name (`--enable-decoder=h264,hevc`: a target's components:, what its
 * options brought, what its patch sets add). Each by the name the build lists it under (the components file's names:,
 * and `names` for a patch set's own). In a kind the target restricted, an option's ships count only where asked for:
 * a support library's (openssl's https) is the target's to list.
 */
export function expectedComponents(
  data: EngineData,
  major: string,
  platform: string,
  configure: string,
  names: RuntimeNames = {},
): Expected[] {
  const on = enabledOptions(data, major, platform, configure);
  const options = optionsOf(data, major);
  const flags = configure.split(/\s+/);
  // (ships: hwaccels are device types, which no hwaccel list restricts)
  const leftOut = (kind: string, name: string): boolean =>
    isComponentKind(kind) && kind !== 'hwaccels' && !inBuild(flags, kind, name);
  const listed = (kind: ShippedKind, name: string): string =>
    isComponentKind(kind) && kind !== 'hwaccels'
      ? runtimeName(data, major, kind, name, names)
      : name;
  const fromOptions = [...on].flatMap((option) =>
    options
      .get(option)!
      .ships.filter(
        (s) =>
          (!s.platforms || platformMatches(platform, s.platforms)) &&
          (s.with ?? []).every((o) => on.has(o)) &&
          !leftOut(s.kind, s.name),
      )
      .map((s) => ({ option, kind: s.kind, name: s.name })),
  );
  const has = new Set(fromOptions.map((e) => `${e.kind} ${e.name}`));
  const fromComponents = LISTED_KINDS.flatMap((kind) =>
    askedFor(flags, kind)
      .filter((name) => !has.has(`${kind} ${name}`))
      .map((name) => ({ option: 'components', kind, name })),
  );
  return [...fromOptions, ...fromComponents].map((e) => ({ ...e, name: listed(e.kind, e.name) }));
}

/** The option an Expected of a build of libraries' defaults is under (DEFAULT_COMPONENTS). */
const DEFAULTS = 'defaults';

/**
 * What a build of libraries is checked to have unless its components: leaves it out, by configure's names: the
 * decoders, formats and bitstream filters most apps use. A kind the target restricts is checked for what it listed
 * instead (expectedComponents).
 */
const DEFAULT_COMPONENTS: Readonly<
  Partial<Record<ShippedKind & ComponentKind, readonly string[]>>
> = {
  decoders: ['h264', 'hevc', 'aac', 'mp3', 'flac', 'pcm_s16le', 'mjpeg'],
  muxers: ['mp4', 'matroska', 'mpegts', 'wav', 'null'],
  demuxers: ['mov', 'matroska', 'mpegts', 'wav'],
  bsfs: ['h264_mp4toannexb', 'aac_adtstoasc'],
};

/** The defaults (DEFAULT_COMPONENTS) a build with this configure line must have, by the names it lists them under. */
export function libraryDefaults(data: EngineData, major: string, configure: string): Expected[] {
  const flags = configure.split(/\s+/);
  return Object.entries(DEFAULT_COMPONENTS)
    .filter(([kind]) => !flags.includes(`--disable-${kind}`))
    .flatMap(([kind, list]) =>
      list.map((name) => ({
        option: DEFAULTS,
        kind: kind as ShippedKind & ComponentKind,
        name: runtimeName(data, major, kind as ComponentKind, name),
      })),
    );
}

/**
 * The codecs the smoke program round-trips a frame with, in order: the first the build has as both encoder and
 * decoder (configure's names, which are their own). All take a 160x120 yuv420p frame at 25 fps.
 */
const ROUND_TRIP = ['mpeg4', 'mpeg2video', 'mpeg1video', 'ffv1', 'rawvideo'] as const;

/** The codec a build with this configure line round-trips a frame with (ROUND_TRIP), or none when it has none of them. */
export function roundTripCodec(configure: string): string | undefined {
  const flags = configure.split(/\s+/);
  return ROUND_TRIP.find((c) => inBuild(flags, 'encoders', c) && inBuild(flags, 'decoders', c));
}

/** Why a build makes no round trip, for the step that says so. */
export const NO_ROUND_TRIP = `it has none of ${ROUND_TRIP.join(', ')} as both encoder and decoder (components:)`;

/** The kinds the smoke program lists everything of (`smoke: lists <kind> <name>`), as ffmpeg's -<kind> does. */
const SMOKE_LISTED = new Set<ShippedKind>([
  'encoders',
  'decoders',
  'muxers',
  'demuxers',
  'bsfs',
  'filters',
  'protocols',
]);

/**
 * The smoke program's arguments: the codecs to round-trip a frame with, and every component of the kinds it can't
 * list (device types, resamplers) that an option of FFmpeg `major` names, as `<kind>:<name>`.
 */
export function smokeProbes(data: EngineData, major: string): string[] {
  const probes = new Set(
    [...optionsOf(data, major).values()].flatMap((o) =>
      o.ships.filter((s) => !SMOKE_LISTED.has(s.kind)).map((s) => `${s.kind}:${s.name}`),
    ),
  );
  return [`roundtrip:${ROUND_TRIP.join(',')}`, ...[...probes].sort()];
}

/**
 * The names in `ffmpeg -encoders`, `-decoders`, `-muxers` and `-demuxers`: each line after the --- is flags (capitals
 * and dots, and `d` for a device, which can stand apart: ` D d lavfi`), then the name.
 */
function tableNames(out: string): string[] {
  const lines = out.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*-+\s*$/.test(l));
  return start < 0
    ? []
    : lines
        .slice(start + 1)
        .map(
          (l) =>
            l
              .trim()
              .split(/\s+/)
              .find((t) => t !== 'd' && /[a-z0-9]/.test(t)) ?? '',
        )
        .flatMap((n) => n.split(','))
        .filter(Boolean);
}

/**
 * The names an `ffmpeg -hide_banner -<kind>` listing has. A muxer or demuxer listed as `mov,mp4,m4a` is each of its
 * names; a filter line is its flags, its name, then its pads (`V->V`); -hwaccels and -protocols list bare names under
 * headings that end in a colon.
 */
export function listedNames(kind: ShippedKind, out: string): Set<string> {
  if (kind === 'filters') {
    return new Set(
      out
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/))
        .filter((t) => t[2]?.includes('->'))
        .map((t) => t[1]!),
    );
  }
  if (kind === 'hwaccels' || kind === 'protocols' || kind === 'bsfs') {
    return new Set(
      out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.endsWith(':') && !/\s/.test(l)),
    );
  }
  return new Set(tableNames(out));
}

/**
 * What the smoke program reported, as a Has: a kind it lists has what its `smoke: lists <kind> <name>` lines name (a
 * format listed as `mov,mp4,m4a` under each), any other what `smoke: has|lacks <kind> <name>` says.
 */
export function smokeReport(out: string): Has {
  const found = new Map<string, boolean>();
  for (const m of out.matchAll(/^smoke: (has|lacks) (\S+) (\S+)\s*$/gm)) {
    found.set(`${m[2]!} ${m[3]!}`, m[1] === 'has');
  }
  for (const m of out.matchAll(/^smoke: lists (\S+) (\S+)\s*$/gm)) {
    for (const name of m[2]!.split(',')) {
      found.set(`${m[1]!} ${name}`, true);
    }
  }
  return (kind, name) =>
    found.get(`${kind} ${listedAs(name)}`) ??
    (SMOKE_LISTED.has(kind) ? false : "the smoke program didn't report it");
}

/** The components the build should have, one step per option: what it has, or what it lacks. */
export function shippedSteps(expected: readonly Expected[], has: Has): Step[] {
  const byOption = new Map<string, Expected[]>();
  for (const e of expected) {
    byOption.set(e.option, [...(byOption.get(e.option) ?? []), e]);
  }
  const describe = (list: Expected[]) => list.map((e) => `${e.kind} ${e.name}`).join(', ');
  return [...byOption].flatMap(([option, list]): Step[] => {
    const results = list.map((e) => ({ e, r: has(e.kind, e.name) }));
    const lacking = results.filter((x) => x.r === false).map((x) => x.e);
    const unknown = results.filter((x) => typeof x.r === 'string');
    const known = results.filter((x) => typeof x.r === 'boolean').map((x) => x.e);
    const steps: Step[] = [];
    if (option === DEFAULTS) {
      if (lacking.length) {
        steps.push({
          ok: false,
          what: `it lacks ${describe(lacking)}, which a build has unless its components: leaves ${lacking.length > 1 ? 'them' : 'it'} out`,
        });
      } else if (known.length) {
        steps.push({ ok: true, what: `it has ${describe(known)}` });
      }
    } else if (lacking.length) {
      steps.push({
        ok: false,
        what: `${option} is on, but the build lacks ${describe(lacking)}`,
        detail: `configure took ${option}, but FFmpeg built without ${lacking.length > 1 ? 'these' : 'it'}: the configure output in the build's log says which of ${lacking.length > 1 ? 'their' : 'its'} needs was missing or too old`,
      });
    } else if (known.length) {
      steps.push({ ok: true, what: `${option} ships ${describe(known)}` });
    }
    for (const { e, r } of unknown) {
      steps.push({ ok: 'info', what: `${option}: ${e.kind} ${e.name} not checked: ${String(r)}` });
    }
    return steps;
  });
}

/** The library a static search finds a component's name in (none: only running the build can tell). */
const STATIC_LIBRARY: Partial<Record<ShippedKind, string>> = {
  encoders: 'avcodec',
  decoders: 'avcodec',
  bsfs: 'avcodec',
  filters: 'avfilter',
  muxers: 'avformat',
  demuxers: 'avformat',
};

/** The library a static search reads for this kind, when one can tell. */
export const staticLibrary = (kind: ShippedKind): string | undefined => STATIC_LIBRARY[kind];

const NUL = 0;

/**
 * Whether a library's bytes hold `name` as a whole string (NUL on both sides): true, false, or 'suffix' when it is
 * there only as the end of a longer string (a linker may share one string's tail with another), which can't be told
 * apart from the name. A static check proves the name is compiled in, not that it is registered: weaker than running,
 * and only for a build nothing here can run.
 */
export function staticHas(bytes: Buffer, name: string): boolean | 'suffix' {
  const whole = Buffer.concat([Buffer.from([NUL]), Buffer.from(name), Buffer.from([NUL])]);
  if (bytes.includes(whole)) {
    return true;
  }
  return bytes.includes(whole.subarray(1)) ? 'suffix' : false;
}

/** The configure line a libavutil holds (avutil_configuration's text): the string with the licence flags in it. */
export function staticConfigure(avutil: Buffer): string | undefined {
  for (const flag of ['--disable-gpl', '--enable-gpl']) {
    const at = avutil.indexOf(flag);
    if (at >= 0) {
      const start = avutil.lastIndexOf(NUL, at) + 1;
      const end = avutil.indexOf(NUL, at);
      return avutil.toString('utf8', start, end < 0 ? avutil.length : end);
    }
  }
  return undefined;
}
