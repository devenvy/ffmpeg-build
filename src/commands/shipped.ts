// Whether a build has what its configure line asked for. Each option's `ships:` in ffmpeg/<major>.yml names what a
// build with it on must report; `ffmpeg-build test` checks those against the build itself: what `ffmpeg -encoders`,
// `-filters`, `-hwaccels`, ... list, or, for a build of libraries, what the smoke program finds through the libraries'
// own lookups. Configure taking an option proves only that it was asked for: FFmpeg drops a component whose own needs
// aren't met without a word (FFmpeg 8.1.2's Vulkan builds shipped with no Vulkan filters, from a glslc too old), and
// this is what catches it. Expectations come from the build's own configure line, so nothing is kept per target.
import {
  type EngineData,
  type OptionInfo,
  optionRecipe,
  optionsOf,
  valuesOn,
} from '../engine-data.ts';
import { COMPONENT_FLAG, COMPONENT_KINDS, type ComponentKind } from '../ffmpeg-components.ts';
import { platformMatches } from '../platforms.ts';
import { SHIPPED_KINDS, type ShippedKind } from '../schema/engine.ts';

import type { Step } from './test-library.ts';

/** A component the build must have: `kind` is the list it is in (ffmpeg -<kind>), `option` the option that adds it. */
export interface Expected {
  option: string;
  kind: ShippedKind;
  name: string;
}

/** Whether the build has a component: true or false, or why that can't be told here. */
export type Has = (kind: ShippedKind, name: string) => boolean | string;

const words = (configure: string): Set<string> => new Set(configure.split(/\s+/).filter(Boolean));

/**
 * An option's FFmpeg flags, by the rule the build passes them by (src/build/plan.ts's optionFlags, which isn't shared:
 * a change to a build module changes every library's cache key): its own `configure:`, else its library's, else
 * `--enable-<name>`.
 */
function optionConfigure(info: OptionInfo, data: EngineData, platform: string): string[] {
  if (info.configure) {
    return info.configure;
  }
  const lib = optionRecipe(info, platform);
  const recipe = lib ? data.recipes.get(lib) : undefined;
  if (lib) {
    return recipe ? valuesOn(recipe, 'configure', platform) : [];
  }
  return [`--enable-${info.name}`];
}

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
        const enables = optionConfigure(info, data, platform).filter((f) =>
          f.startsWith('--enable-'),
        );
        return enables.length > 0 && enables.every((f) => flags.has(f));
      })
      .map((info) => info.name),
  );
}

/** What a build of FFmpeg `major` for `platform` with this configure line must have. */
export function expectedComponents(
  data: EngineData,
  major: string,
  platform: string,
  configure: string,
): Expected[] {
  const on = enabledOptions(data, major, platform, configure);
  const options = optionsOf(data, major);
  const fromOptions: Expected[] = [...on].flatMap((option) =>
    options
      .get(option)!
      .ships.filter(
        (s) =>
          (!s.platforms || platformMatches(platform, s.platforms)) &&
          (s.with ?? []).every((o) => on.has(o)),
      )
      .map((s) => ({ option, kind: s.kind, name: s.name })),
  );
  // a restricted kind (components:): --disable-decoders --enable-decoder=h264,hevc. Each name must be in the build,
  // as `ffmpeg -<kind>` lists it; -hwaccels lists types (vaapi), not these names, so those stay configure's to check
  const flags = configure.split(/\s+/);
  const has = new Set(fromOptions.map((e) => `${e.kind} ${e.name}`));
  const fromComponents: Expected[] = COMPONENT_KINDS.filter(
    (k): k is ComponentKind & ShippedKind =>
      k !== 'hwaccels' && (SHIPPED_KINDS as readonly string[]).includes(k),
  )
    .filter((k) => flags.includes(`--disable-${k}`))
    .flatMap((kind) =>
      flags
        .filter((f) => f.startsWith(`--enable-${COMPONENT_FLAG[kind]}=`))
        .flatMap((f) => f.slice(f.indexOf('=') + 1).split(','))
        .filter((name) => name && !has.has(`${kind} ${name}`))
        .map((name) => ({ option: 'components', kind, name })),
    );
  return [...fromOptions, ...fromComponents];
}

/** Every component any option of FFmpeg `major` names, as the smoke program's `<kind>:<name>` arguments. */
export function smokeProbes(data: EngineData, major: string): string[] {
  return [
    ...new Set(
      [...optionsOf(data, major).values()].flatMap((o) =>
        o.ships.map((s) => `${s.kind}:${s.name}`),
      ),
    ),
  ].sort();
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
  if (kind === 'hwaccels' || kind === 'protocols') {
    return new Set(
      out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.endsWith(':') && !/\s/.test(l)),
    );
  }
  return new Set(tableNames(out));
}

/** What the smoke program reported: `smoke: has <kind> <name>` or `smoke: lacks <kind> <name>`, per component. */
export function smokeReport(out: string): Map<string, boolean> {
  const found = new Map<string, boolean>();
  for (const m of out.matchAll(/^smoke: (has|lacks) (\S+) (\S+)\s*$/gm)) {
    found.set(`${m[2]!} ${m[3]!}`, m[1] === 'has');
  }
  return found;
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
    if (lacking.length) {
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
