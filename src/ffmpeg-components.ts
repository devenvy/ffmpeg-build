// FFmpeg's components: what a source tree has, read the way its configure reads them (find_things_extern and
// find_filters_extern scan the `extern` declarations in the files below), so a name the engine accepts is a name
// configure knows. A target's `components:` restricts these kinds to the names it lists.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

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
const THINGS: Record<Exclude<ComponentKind, 'filters'>, { file: string; type: string; thing: string }> =
  {
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

/** Every component of each kind, sorted, from the texts of COMPONENT_FILES (by path). */
export function parseComponents(files: Record<string, string>): Components {
  const lines = (file: string): string[] => {
    const text = files[file];
    if (text === undefined) {
      throw new Error(`FFmpeg's ${file} is missing`);
    }
    return text.split(/\r?\n/);
  };
  const out = {} as Components;
  for (const [kind, { file, type, thing }] of Object.entries(THINGS) as [
    Exclude<ComponentKind, 'filters'>,
    (typeof THINGS)[keyof typeof THINGS],
  ][]) {
    // sed -n "s/^[^#]*extern.*$pattern *ff_\([^ ]*\)_$thing;/\1/p", minus lines commented out with //
    const re = new RegExp(`^[^#]*extern.*${type} *ff_([^ ]*)_${thing};`);
    out[kind] = lines(file)
      .filter((l) => !l.trimStart().startsWith('//'))
      .map((l) => re.exec(l)?.[1])
      .filter((n): n is string => n !== undefined)
      .sort();
  }
  out.filters = lines(FILTERS_FILE)
    .map((l) => FILTER.exec(l)?.[1])
    .filter((n): n is string => n !== undefined)
    .sort();
  return Object.fromEntries(COMPONENT_KINDS.map((k) => [k, out[k]])) as Components;
}

/** One FFmpeg major's components, as ffmpeg/components/<major>.yml keeps them: the release they were read from. */
export interface ComponentsFile {
  release: string;
  components: Components;
}

/** ffmpeg/components/<major>.yml */
export const componentsFilePath = (dataRoot: string, major: string): string =>
  join(dataRoot, 'ffmpeg', 'components', `${major}.yml`);

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
    // quoted where YAML would read the bare name as something else: FFmpeg has a `null` muxer
    const item = (n: string) => (parse(n) === n ? n : `'${n}'`);
    out.push(names.length ? `${kind}:` : `${kind}: []`, ...names.map((n) => `  - ${item(n)}`));
  }
  return `${out.join('\n')}\n`;
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
    components[kind] = names as string[];
  }
  return { release: raw['release'], components };
}

/** Whether two sets of lists are the same, kind by kind. */
export const sameComponents = (a: Components, b: Components): boolean =>
  COMPONENT_KINDS.every((k) => a[k].join() === b[k].join());

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
