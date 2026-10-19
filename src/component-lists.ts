// What a target's `components:` builds: each kind it lists, with only those names and what comes with them (the
// components of that kind its options need, and what its patch sets add). Shared by the build (configure's flags),
// `check` (what a name needs) and `ffmpeg-build test` (what a build must have, by the names it lists them under).
import {
  type EngineData,
  type OptionInfo,
  optionRecipe,
  optionsOf,
  valuesOn,
} from './engine-data.ts';
import {
  COMPONENT_FLAG,
  COMPONENT_KINDS,
  type ComponentKind,
  type Components,
  type RuntimeNames,
} from './ffmpeg-components.ts';
import { platformMatches } from './platforms.ts';
import { unique } from './text.ts';

/**
 * An option's FFmpeg flags on a platform, by the rule the build passes them by: its own `configure:`, else its
 * library's, else `--enable-<name>`.
 */
export function optionConfigure(data: EngineData, info: OptionInfo, platform: string): string[] {
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

/** The configure options flags turn on: --enable-vaapi is vaapi, --enable-cuda-llvm cuda_llvm (not --enable-x=y). */
export const configureOptions = (flags: readonly string[]): Set<string> =>
  new Set(
    flags
      .map((f) => /^--enable-([a-z0-9-]+)$/.exec(f)?.[1]?.replaceAll('-', '_'))
      .filter((o): o is string => o !== undefined),
  );

/** Whether these options on meet a component's needs: each need's option, or one of `a|b`. */
export const needsMet = (needs: readonly string[], on: ReadonlySet<string>): boolean =>
  needs.every((n) => n.split('|').some((o) => on.has(o)));

/** Where a target builds, with what on. */
export interface ComponentTarget {
  major: string;
  platform: string;
  options: readonly string[]; // the options on
}

/** The configure options on for a target: its platform's and its options' --enable- flags. */
export function optionsOn(data: EngineData, t: ComponentTarget): Set<string> {
  const options = optionsOf(data, t.major);
  return configureOptions([
    ...(data.platforms.get(t.platform)?.configure ?? []),
    ...t.options.flatMap((o) => {
      const info = options.get(o);
      return info ? optionConfigure(data, info, t.platform) : [];
    }),
  ]);
}

/**
 * The components each kind gets from the target's options: those whose needs its options meet, one of them met by an
 * option that brings its components (`auto-components: true`; a support library's dependents, png for zlib, aren't
 * brought), and what those options ship, where its conditions hold. Not `ships:` hwaccels, which name device types.
 */
export function broughtComponents(data: EngineData, t: ComponentTarget): Partial<Components> {
  const options = optionsOf(data, t.major);
  const on = optionsOn(data, t);
  const autos = t.options.map((o) => options.get(o)).filter((o) => o?.autoComponents === true);
  const bringing = configureOptions(autos.flatMap((o) => optionConfigure(data, o!, t.platform)));
  const out: Partial<Components> = {};
  const needs = data.components.get(t.major)?.needs ?? {};
  for (const kind of COMPONENT_KINDS) {
    for (const [name, need] of Object.entries(needs[kind] ?? {})) {
      const brought = need.some((n) => n.split('|').some((o) => on.has(o) && bringing.has(o)));
      if (brought && needsMet(need, on)) {
        (out[kind] ??= []).push(name);
      }
    }
  }
  for (const s of autos.flatMap((o) => o!.ships)) {
    const holds =
      (s.with ?? []).every((w) => t.options.includes(w)) &&
      (!s.platforms || platformMatches(t.platform, s.platforms));
    const kind = s.kind as ComponentKind;
    if (holds && s.kind !== 'hwaccels' && (COMPONENT_KINDS as readonly string[]).includes(kind)) {
      out[kind] = unique([...(out[kind] ?? []), s.name]);
    }
  }
  return out;
}

/**
 * The flags that build only the components a target lists: each kind it restricts is turned off, then on for its
 * names, what its options bring and what its patch sets add (`adds`); a kind it leaves alone is asked by name for what
 * its patch sets add, so `ffmpeg-build test` finds those in the configure line too.
 */
export function componentFlags(
  data: EngineData,
  t: ComponentTarget & { components?: Partial<Components> },
  adds: Partial<Components> = {},
): string[] {
  const restricted = t.components ?? {};
  const brought = COMPONENT_KINDS.some((k) => restricted[k]) ? broughtComponents(data, t) : {};
  return COMPONENT_KINDS.flatMap((k) => {
    const names = unique([...(restricted[k] ?? []), ...(brought[k] ?? []), ...(adds[k] ?? [])]);
    const enable = names.length ? [`--enable-${COMPONENT_FLAG[k]}=${names.join(',')}`] : [];
    if (restricted[k]) {
      return [`--disable-${k}`, ...enable];
    }
    return adds[k]?.length ? enable : [];
  });
}

/** A component's name as a build lists it: its own where that isn't configure's (the components file's names:). */
export function runtimeName(
  data: EngineData,
  major: string,
  kind: ComponentKind,
  name: string,
  extra: RuntimeNames = {},
): string {
  return extra[kind]?.[name] ?? data.components.get(major)?.names[kind]?.[name] ?? name;
}
