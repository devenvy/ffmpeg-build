// FFmpeg's components: what a source tree has, read the way its configure reads them (find_things_extern and
// find_filters_extern scan the `extern` declarations in the files below), so a name the engine accepts is a name
// configure knows. A target's `components:` restricts these kinds to the names it lists.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { Sources, type Tok } from './c-macros.ts';

/** The kinds a target can restrict, as configure names its lists (`--disable-decoders`, `--enable-decoder=`). */
export const COMPONENT_KINDS = [
  'decoders',
  'encoders',
  'hwaccels',
  'demuxers',
  'muxers',
  'parsers',
  'bsfs',
  'protocols',
  'indevs',
  'outdevs',
  'filters',
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];
export type Components = Record<ComponentKind, string[]>;

/** One kind's configure flag: --enable-<flag>=a,b */
export const COMPONENT_FLAG: Record<ComponentKind, string> = {
  decoders: 'decoder',
  encoders: 'encoder',
  hwaccels: 'hwaccel',
  demuxers: 'demuxer',
  muxers: 'muxer',
  parsers: 'parser',
  bsfs: 'bsf',
  protocols: 'protocol',
  indevs: 'indev',
  outdevs: 'outdev',
  filters: 'filter',
};

/** configure's find_things_extern: the file, the declared type, and the suffix it strips (ff_<name>_<thing>). */
const THINGS: Record<
  Exclude<ComponentKind, 'filters'>,
  { file: string; type: string; thing: string }
> = {
  decoders: { file: 'libavcodec/allcodecs.c', type: 'FFCodec', thing: 'decoder' },
  encoders: { file: 'libavcodec/allcodecs.c', type: 'FFCodec', thing: 'encoder' },
  hwaccels: { file: 'libavcodec/hwaccels.h', type: 'FFHWAccel', thing: 'hwaccel' },
  demuxers: { file: 'libavformat/allformats.c', type: 'FFInputFormat', thing: 'demuxer' },
  muxers: { file: 'libavformat/allformats.c', type: 'FFOutputFormat', thing: 'muxer' },
  parsers: { file: 'libavcodec/parsers.c', type: 'FFCodecParser', thing: 'parser' },
  bsfs: { file: 'libavcodec/bitstream_filters.c', type: 'FFBitStreamFilter', thing: 'bsf' },
  protocols: { file: 'libavformat/protocols.c', type: 'URLProtocol', thing: 'protocol' },
  // devices are declared as demuxers and muxers in libavdevice
  indevs: { file: 'libavdevice/alldevices.c', type: 'FFInputFormat', thing: 'demuxer' },
  outdevs: { file: 'libavdevice/alldevices.c', type: 'FFOutputFormat', thing: 'muxer' },
};
const FILTERS_FILE = 'libavfilter/allfilters.c';

/** configure's find_filters_extern: ff_vf_scale, ff_af_aresample, ff_vsrc_testsrc, ff_asink_anullsink. */
const FILTER = /^extern const FFFilter ff_[avfsinkrc]{2,5}_([A-Za-z0-9_]+);/;

/** The files configure reads its component lists from, relative to the source tree's root. */
export const COMPONENT_FILES = [
  ...new Set([...Object.values(THINGS).map((t) => t.file), FILTERS_FILE]),
].sort();

/** Each component of each kind, by name, and the symbol FFmpeg declares it as (ff_libx264_encoder, ff_vf_scale). */
function componentSymbols(
  files: Readonly<Record<string, string>>,
): Record<ComponentKind, Map<string, string>> {
  const lines = (file: string): string[] => {
    const text = files[file];
    if (text === undefined) {
      throw new Error(`FFmpeg's ${file} is missing`);
    }
    return text.split(/\r?\n/);
  };
  const out = {} as Record<ComponentKind, Map<string, string>>;
  for (const [kind, { file, type, thing }] of Object.entries(THINGS) as [
    Exclude<ComponentKind, 'filters'>,
    (typeof THINGS)[keyof typeof THINGS],
  ][]) {
    // sed -n "s/^[^#]*extern.*$pattern *ff_\([^ ]*\)_$thing;/\1/p", minus lines commented out with //
    const re = new RegExp(`^[^#]*extern.*${type} *ff_([^ ]*)_${thing};`);
    out[kind] = new Map(
      lines(file)
        .filter((l) => !l.trimStart().startsWith('//'))
        .map((l) => re.exec(l)?.[1])
        .filter((n): n is string => n !== undefined)
        .map((n) => [n, `ff_${n}_${thing}`]),
    );
  }
  out.filters = new Map(
    lines(FILTERS_FILE)
      .map((l) => FILTER.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1]!, m[0].slice(m[0].indexOf('ff_'), -1)]),
  );
  return out;
}

/** Every component of each kind, sorted, from the texts of COMPONENT_FILES (by path). */
function parseComponents(files: Readonly<Record<string, string>>): Components {
  const symbols = componentSymbols(files);
  return Object.fromEntries(
    COMPONENT_KINDS.map((k) => [k, [...symbols[k].keys()].sort()]),
  ) as Components;
}

/**
 * The kinds whose components a build lists by their own names (`ffmpeg -encoders`, `-protocols`, `-bsfs`, ...): the
 * name in the component's definition (`.p.name = "libvpx"` for configure's libvpx_vp8). Not hwaccels (`-hwaccels`
 * lists device types) or parsers (which have no name).
 */
const NAMED_KINDS = [
  'decoders',
  'encoders',
  'demuxers',
  'muxers',
  'bsfs',
  'protocols',
  'indevs',
  'outdevs',
  'filters',
] as const satisfies readonly ComponentKind[];
type NamedKind = (typeof NAMED_KINDS)[number];

/** Each kind's runtime names where they differ from configure's: { encoders: { libvpx_vp8: libvpx } }. */
export type RuntimeNames = Partial<Record<ComponentKind, Record<string, string>>>;

/** The structs FFmpeg defines its components with. */
const DEFINITION = new Set([
  'FFCodec',
  'FFInputFormat',
  'FFOutputFormat',
  'URLProtocol',
  'FFFilter',
  'FFBitStreamFilter',
]);

/** `FFCodec ff_x = {`: the tokens a definition starts with. */
const DEFINITION_HEAD = 4;

/** A string literal's text (FFmpeg's names hold no escapes worth reading). */
const unquote = (s: string): string => s.slice(1, -1).replace(/\\(.)/g, '$1');

/** Whether the tokens from `at` are these texts. */
const tokensAt = (toks: readonly Tok[], at: number, texts: readonly string[]): boolean =>
  texts.every((t, i) => toks[at + i]?.t === t);

/** The tokens of the brace group whose `{` is at `open`, without its braces. */
function braceGroup(toks: readonly Tok[], open: number): Tok[] {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    depth += toks[i]!.t === '{' ? 1 : 0;
    depth -= toks[i]!.t === '}' ? 1 : 0;
    if (depth === 0) {
      return toks.slice(open + 1, i);
    }
  }
  return toks.slice(open + 1);
}

/** Adjacent string literals from `at`, joined ('' when there are none). */
function stringsAt(toks: readonly Tok[], at: number): string {
  let out = '';
  for (let i = at; toks[i]?.t.startsWith('"'); i++) {
    out += unquote(toks[i]!.t);
  }
  return out;
}

const P_NAME = ['.', 'p', '.', 'name', '='];
const NAME = ['.', 'name', '='];
const P_GROUP = ['.', 'p', '=', '{'];

/** An initializer's name: `.p.name = "x"` or `.name = "x"` in it, or `.name` in its `.p = { ... }`. */
function initializerName(init: readonly Tok[]): string | undefined {
  let depth = 0;
  for (let i = 0; i < init.length; i++) {
    const field = depth === 0 && init[i]!.t === '.';
    const name =
      (field && tokensAt(init, i, P_NAME) && stringsAt(init, i + P_NAME.length)) ||
      (field && tokensAt(init, i, NAME) && stringsAt(init, i + NAME.length)) ||
      (field &&
        tokensAt(init, i, P_GROUP) &&
        initializerName(braceGroup(init, i + P_GROUP.length - 1)));
    if (name) {
      return name;
    }
    depth += init[i]!.t === '{' ? 1 : 0;
    depth -= init[i]!.t === '}' ? 1 : 0;
  }
  return undefined;
}

/**
 * The name each definition in these top-level statements gives: `const FFCodec ff_x_encoder = { .p.name = "x", ... }`
 * (or `.name`, or `.p = { .name = ... }`), adjacent strings joined.
 */
function definedNames(statements: readonly Tok[][], into: Map<string, string>): void {
  for (const toks of statements) {
    toks.forEach((tok, i) => {
      // FFCodec ff_x = {
      const [, symbol, equals, open] = toks.slice(i, i + DEFINITION_HEAD);
      const sym = symbol?.t ?? '';
      const defines =
        DEFINITION.has(tok.t) && sym.startsWith('ff_') && equals?.t === '=' && open?.t === '{';
      const name = defines ? initializerName(braceGroup(toks, toks.indexOf(open, i))) : undefined;
      if (name && !into.has(sym)) {
        into.set(sym, name);
      }
    });
  }
}

/**
 * The configure options each component needs: { encoders: { h264_vaapi: [vaapi] }, filters: { scale_cuda:
 * [ffnvcodec, cuda_llvm|cuda_nvcc] } }. Each entry is an option it needs, or `a|b` for options of which it needs one.
 * Components that need none aren't listed.
 */
export type ComponentNeeds = Partial<Record<ComponentKind, Record<string, string[]>>>;

/** Each `x_deps`, `x_deps_any` and `x_select` line of a configure script: { x: { deps: [...], ... } }. */
function dependencyLines(
  configure: string,
): Map<string, { deps: string[]; any: string[]; select: string[] }> {
  const out = new Map<string, { deps: string[]; any: string[]; select: string[] }>();
  for (const m of configure.matchAll(/^([a-z0-9_]+)_(deps|deps_any|select)="([^"$]*)"/gm)) {
    const entry = out.get(m[1]!) ?? { deps: [], any: [], select: [] };
    const key = ({ deps: 'deps', deps_any: 'any', select: 'select' } as const)[
      m[2] as 'deps' | 'deps_any' | 'select'
    ];
    entry[key] = m[3]!.split(/\s+/).filter(Boolean);
    out.set(m[1]!, entry);
  }
  return out;
}

/**
 * The options configure turns on for another: `enabled fontconfig && enable libfontconfig`, and libvpl's check, which
 * is libmfx's (`elif enabled libvpl; then check_pkg_config libmfx ...`). { libmfx: [libvpl] }: libmfx is on with libvpl.
 */
function implications(configure: string, options: ReadonlySet<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (on: string, implied: string): void => {
    if (on !== implied && options.has(on) && options.has(implied)) {
      out.set(implied, [...new Set([...(out.get(implied) ?? []), on])].sort());
    }
  };
  let block: string | undefined; // the option of the `if enabled x; then` block we're in
  for (const line of configure.split(/\r?\n/)) {
    const one = /^enabled ([a-z0-9_]+)\s+&& enable ([a-z0-9_]+)\s*$/.exec(line);
    const check = /^\s+(?:\{\s*)?(?:check|require)_pkg_config ([a-z0-9_]+)/.exec(line);
    if (one) {
      add(one[1]!, one[2]!);
    }
    if (/^[^\s#]/.test(line)) {
      // a line at the left (not a comment) ends the block, or starts one
      block = /^(?:el)?if enabled ([a-z0-9_]+); then\s*$/.exec(line)?.[1];
    } else if (block && check) {
      add(block, check[1]!);
    }
  }
  return out;
}

/**
 * What each component needs of configure's options (`options`: its external and hwaccel libraries), from configure's
 * own rules: what it `_deps` on and what it `_select`s, followed through (h264_vaapi_encoder selects vaapi_encode,
 * which deps on vaapi), and of a `_deps_any` made only of options, one of them. An option another turns on is either
 * (libmfx|libvpl). A component configure drops when they are off: when a target lists a kind, the components of it its
 * options need come with them.
 */
export function readNeeds(
  configure: string,
  components: Components,
  options: ReadonlySet<string>,
): ComponentNeeds {
  const lines = dependencyLines(configure);
  const implied = implications(configure, options);
  // each need is a set of alternatives: { vaapi }, or { cuda_llvm, cuda_nvcc } for one of them
  const memo = new Map<string, string[][]>();
  const needsOf = (item: string, seen: Set<string>): string[][] => {
    const known = memo.get(item);
    if (known) {
      return known;
    }
    if (seen.has(item)) {
      return []; // configure refuses a cycle; this only stops a select loop
    }
    seen.add(item);
    const line = lines.get(item);
    const sets: string[][] = [];
    for (const dep of [...(line?.deps ?? []), ...(line?.select ?? [])]) {
      if (options.has(dep)) {
        sets.push([dep]);
      }
      sets.push(...needsOf(dep, seen));
    }
    const any = line?.any ?? [];
    if (any.length && any.every((a) => options.has(a))) {
      sets.push(any);
    }
    memo.set(item, sets);
    return sets;
  };
  /** The needs as written: an option that turns another on is an alternative to it; a need implied by another goes. */
  const spell = (sets: string[][]): string[] => {
    const full = sets.map((s) => [...new Set(s.flatMap((a) => [a, ...(implied.get(a) ?? [])]))]);
    const key = (s: string[]): string => [...s].sort().join('|');
    const distinct = [...new Map(full.map((s) => [key(s), s])).values()];
    // a need met whenever a narrower one is ([libmfx|libvpl] beside [libvpl]) says nothing more
    return distinct
      .filter((s) => !distinct.some((t) => t !== s && t.every((a) => s.includes(a))))
      .map(key)
      .sort();
  };
  const out: ComponentNeeds = {};
  for (const kind of COMPONENT_KINDS) {
    for (const name of components[kind]) {
      const needs = spell(needsOf(`${name}_${COMPONENT_FLAG[kind]}`, new Set()));
      if (needs.length) {
        (out[kind] ??= {})[name] = needs;
      }
    }
  }
  return out;
}

/** The sources the runtime names are read from: FFmpeg's libraries' .c, .h and .m files. */
export const isNameSource = (path: string): boolean =>
  /^lib(avcodec|avformat|avdevice|avfilter|avutil)\/.*\.[chm]$/.test(path);

/**
 * Each component's runtime name where it isn't its configure name, read from FFmpeg's sources (every path
 * isNameSource takes, with COMPONENT_FILES): `unread` lists the components whose definition wasn't found.
 */
export function readRuntimeNames(files: ReadonlyMap<string, string>): {
  names: RuntimeNames;
  unread: string[];
} {
  const symbols = componentSymbols(Object.fromEntries(files));
  const sources = new Sources(files);
  const defined = new Map<string, string>();
  // the C files, and the Objective-C ones (Apple's devices and filters)
  for (const path of [...files.keys()].filter((p) => /\.[cm]$/.test(p)).sort()) {
    definedNames(sources.topLevel(path), defined);
  }
  const names: RuntimeNames = {};
  const unread: string[] = [];
  for (const kind of NAMED_KINDS satisfies readonly NamedKind[]) {
    for (const [name, sym] of symbols[kind]) {
      const runtime = defined.get(sym);
      if (runtime === undefined) {
        unread.push(`${COMPONENT_FLAG[kind]} ${name}`);
      } else if (runtime !== name) {
        (names[kind] ??= {})[name] = runtime;
      }
    }
  }
  return { names, unread };
}

/**
 * One FFmpeg major's components, as ffmpeg/components/<major>.yml keeps them: the release they were read from, each
 * kind's names (configure's), the runtime names that differ, and what each component needs of configure's options.
 */
export interface ComponentsFile {
  release: string;
  components: Components;
  names: RuntimeNames;
  needs: ComponentNeeds;
}

/** What the support check reads of a release: its components, their names and needs, and which names it couldn't read. */
export type ComponentsRead = Omit<ComponentsFile, 'release'> & { unread: string[] };

/**
 * A release's components from its sources (paths from the tree's root: `configure`, COMPONENT_FILES and every path
 * isNameSource takes), with what each needs of `options` (configure's external and hwaccel libraries).
 */
export function componentsFromSources(
  files: ReadonlyMap<string, string>,
  options: ReadonlySet<string>,
): ComponentsRead {
  const configure = files.get('configure');
  if (configure === undefined) {
    throw new Error("FFmpeg's configure is missing");
  }
  const components = parseComponents(Object.fromEntries(files));
  const { names, unread } = readRuntimeNames(files);
  return { components, names, needs: readNeeds(configure, components, options), unread };
}

/** ffmpeg/components/<major>.yml */
export const componentsFilePath = (dataRoot: string, major: string): string =>
  join(dataRoot, 'ffmpeg', 'components', `${major}.yml`);

/** A name as YAML text: quoted where YAML would read the bare name as something else (FFmpeg has a `null` muxer). */
const yamlName = (n: string): string => ((parse(`- ${n}`) as unknown[])[0] === n ? n : `'${n}'`);

/** The file's text: block lists, one name per line, as Prettier leaves them. */
export function formatComponentsFile(major: string, f: ComponentsFile): string {
  const out = [
    `# FFmpeg ${major}'s components, as the configure of its newest release (${f.release}) lists them. A target's`,
    '# `components:` names are checked against these. Written by the nightly support check (scripts/ffmpeg-support.ts',
    '# --write): not edited by hand.',
    `release: ${f.release}`,
  ];
  for (const kind of COMPONENT_KINDS) {
    const names = f.components[kind];
    out.push(names.length ? `${kind}:` : `${kind}: []`, ...names.map((n) => `  - ${yamlName(n)}`));
  }
  const section = <T>(
    key: string,
    comment: string[],
    map: Partial<Record<ComponentKind, Record<string, T>>>,
    value: (v: T) => string,
  ): void => {
    const kinds = COMPONENT_KINDS.filter((k) => Object.keys(map[k] ?? {}).length);
    if (!kinds.length) {
      return;
    }
    out.push(...comment.map((c) => `# ${c}`), `${key}:`);
    for (const kind of kinds) {
      out.push(`  ${kind}:`);
      for (const [name, v] of Object.entries(map[kind]!).sort(([a], [b]) => (a < b ? -1 : 1))) {
        out.push(`    ${yamlName(name)}: ${value(v)}`);
      }
    }
  };
  section(
    'names',
    [
      "Each component's own name, where it isn't configure's: what `ffmpeg -encoders`, `-demuxers`, ... list (a format",
      'with several names lists them all) and what `ffmpeg-build test` looks for.',
    ],
    f.names,
    yamlName,
  );
  section(
    'needs',
    [
      "The configure options each component needs (configure's _deps, _select and _deps_any, followed through; `a|b`:",
      'one of them). When a target lists a kind, the components of it that its options need come with them.',
    ],
    f.needs,
    (v: string[]) => `[${v.join(', ')}]`,
  );
  return `${out.join('\n')}\n`;
}

/** A map of kind -> component -> T, checked: `names:` and `needs:`. */
function byKind<T>(
  raw: unknown,
  key: string,
  label: string,
  ok: (v: unknown) => v is T,
  what: string,
): Partial<Record<ComponentKind, Record<string, T>>> {
  if (raw === undefined) {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label}: ${key}: is not a map of kinds`);
  }
  const out: Partial<Record<ComponentKind, Record<string, T>>> = {};
  for (const [kind, entries] of Object.entries(raw) as [string, unknown][]) {
    const valid =
      (COMPONENT_KINDS as readonly string[]).includes(kind) &&
      entries &&
      typeof entries === 'object' &&
      !Array.isArray(entries) &&
      Object.values(entries).every(ok);
    if (!valid) {
      throw new Error(`${label}: ${key}: ${kind}: is not a map of components to ${what}`);
    }
    out[kind as ComponentKind] = entries as Record<string, T>;
  }
  return out;
}

/** A ffmpeg/components/<major>.yml's contents; a malformed file throws, saying what is wrong. */
export function parseComponentsFile(text: string, label: string): ComponentsFile {
  const raw = parse(text) as Record<string, unknown> | null;
  if (!raw || typeof raw['release'] !== 'string') {
    throw new Error(`${label}: no release: (the FFmpeg release these lists were read from)`);
  }
  const components = {} as Components;
  for (const kind of COMPONENT_KINDS) {
    const names = raw[kind];
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) {
      throw new Error(`${label}: ${kind}: is not a list of names`);
    }
    components[kind] = names;
  }
  return {
    release: raw['release'],
    components,
    names: byKind(
      raw['names'],
      'names',
      label,
      (v): v is string => typeof v === 'string',
      'their names',
    ),
    needs: byKind(
      raw['needs'],
      'needs',
      label,
      (v): v is string[] => Array.isArray(v) && v.every((n) => typeof n === 'string'),
      'lists of options',
    ),
  };
}

/** Every component of each kind the FFmpeg source tree at `src` has, sorted. */
export function readComponents(src: string): Components {
  return parseComponents(
    Object.fromEntries(
      COMPONENT_FILES.map((file) => {
        const path = join(src, file);
        if (!existsSync(path)) {
          throw new Error(`${src} is not an FFmpeg source tree: it has no ${file}`);
        }
        return [file, readFileSync(path, 'utf8')];
      }),
    ),
  );
}
