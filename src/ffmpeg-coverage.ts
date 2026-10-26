// The coverage gate: everything FFmpeg's configure offers to turn on (its external library and hardware options, as
// ffmpeg/offered/<major>.yml keeps them) is either turned on by an option of ffmpeg/<major>.yml or listed in
// ffmpeg/unsupported.yml with a reason. tests/ffmpeg-coverage.test.ts holds the engine's own data to it on every pull
// request, so a new FFmpeg option (the nightly support check writes it into ffmpeg/offered/) can't go unnoticed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import {
  alwaysBuilt,
  type EngineData,
  linkageFlagsOf,
  type OptionInfo,
  optionRecipe,
  optionsOf,
  valuesOn,
} from './engine-data.ts';
import { expandPlatforms, platformMatches } from './platforms.ts';
import { formatIssues } from './schema/common.ts';
import { parseYaml } from './yaml.ts';

/** A licence class configure gives a library: what a build must --enable to use it. */
type LicenseClass = 'gpl' | 'version3' | 'gplv3' | 'nonfree';

/** configure's library lists, by the name ffmpeg/offered/ gives each; `help` is --help's library section. */
const LISTS = {
  external: 'EXTERNAL_LIBRARY_LIST',
  'external-autodetect': 'EXTERNAL_AUTODETECT_LIBRARY_LIST',
  hwaccel: 'HWACCEL_LIBRARY_LIST',
  'hwaccel-autodetect': 'HWACCEL_AUTODETECT_LIBRARY_LIST',
} as const;
const LIST_NAMES = [
  'external',
  'external-autodetect',
  'hwaccel',
  'hwaccel-autodetect',
  'help',
] as const;
type OfferedList = (typeof LIST_NAMES)[number];

/** configure's licence lists: a library in one needs that licence switch on. */
const CLASS_LISTS: [string, LicenseClass][] = [
  ['EXTERNAL_LIBRARY_GPL_LIST', 'gpl'],
  ['EXTERNAL_LIBRARY_NONFREE_LIST', 'nonfree'],
  ['EXTERNAL_LIBRARY_VERSION3_LIST', 'version3'],
  ['EXTERNAL_LIBRARY_GPLV3_LIST', 'gplv3'],
  ['HWACCEL_LIBRARY_NONFREE_LIST', 'nonfree'],
];

/** The licence switches a class needs on. */
const CLASS_NEEDS: Record<LicenseClass, string[]> = {
  gpl: ['gpl'],
  version3: ['version3'],
  gplv3: ['gpl', 'version3'],
  nonfree: ['nonfree'],
};

/** One option configure offers: the lists it is in, and its licence class (none: any build may have it). */
interface OfferedOption {
  lists: OfferedList[];
  license?: LicenseClass;
}

/** One FFmpeg major's configure, as ffmpeg/offered/<major>.yml keeps it. */
export interface Offered {
  release: string; // the release it was read from: the major's newest
  options: Record<string, OfferedOption>; // the libraries and hardware it can turn on, by configure name
  flags: string[]; // every other name --enable-/--disable- takes (gpl, pic, ...), to check the data's flags against
}

/** configure isn't in the shape this reads (a list gone or renamed): nothing is guessed. */
export class ConfigureError extends Error {}

const byName = <T>([a]: [string, T], [b]: [string, T]): number => (a < b ? -1 : 1);

/** configure's NAME="..." lists, each a list of words ($OTHER_LIST for another list's). */
function listsOf(text: string): Map<string, string[]> {
  const lists = new Map<string, string[]>();
  for (const m of text.matchAll(/^([A-Z0-9_]+)="\n([\s\S]*?)^"/gm)) {
    lists.set(m[1]!, m[2]!.split(/\s+/).filter(Boolean));
  }
  return lists;
}

/**
 * A list with every $LIST in it expanded. Strict: a list that isn't there fails (the library lists must all be read);
 * otherwise it is left out ($COMPONENT_LIST and the like are filled in at run time, from the sources).
 */
function expandList(
  lists: Map<string, string[]>,
  name: string,
  strict: boolean,
  seen = new Set<string>(),
): string[] {
  if (seen.has(name)) {
    return [];
  }
  seen.add(name);
  const words = lists.get(name);
  if (!words && strict) {
    throw new ConfigureError(`configure has no ${name}: its library lists changed shape`);
  }
  return (words ?? []).flatMap((w) =>
    w.startsWith('$') ? expandList(lists, w.slice(1), strict, seen) : [w],
  );
}

/** What a configure script offers: its library lists, their licence classes, --help's library section. */
export function readConfigure(text: string): Omit<Offered, 'release'> {
  const lists = listsOf(text);
  const options = new Map<string, OfferedOption>();
  const add = (name: string, list: OfferedList) => {
    const o = options.get(name) ?? { lists: [] };
    o.lists = [...new Set([...o.lists, list])];
    options.set(name, o);
  };
  for (const [key, list] of Object.entries(LISTS) as [OfferedList, string][]) {
    expandList(lists, list, true).forEach((n) => {
      add(n, key);
    });
  }
  const help = /^External library support:\n([\s\S]*?)^\S/m.exec(text);
  if (!help) {
    throw new ConfigureError("configure's --help has no External library support: section");
  }
  for (const m of help[1]!.matchAll(/^ {2}--(?:enable|disable)-([a-z0-9-]+)\s/gm)) {
    const name = m[1]!.replaceAll('-', '_');
    if (!options.has(name)) {
      add(name, 'help');
    }
  }
  for (const [list, cls] of CLASS_LISTS) {
    for (const o of expandList(lists, list, true).map((n) => options.get(n))) {
      if (o) {
        o.license = cls;
      }
    }
  }
  const cmdline = expandList(lists, 'CMDLINE_SELECT', false);
  return {
    options: Object.fromEntries([...options].sort(byName)),
    flags: [...new Set(cmdline.filter((n) => !options.has(n)))].sort(),
  };
}

/** ffmpeg/offered/<major>.yml */
export const offeredFilePath = (dataRoot: string, major: string): string =>
  join(dataRoot, 'ffmpeg', 'offered', `${major}.yml`);

/** The file's text: one option per line, the other flags one per line, as Prettier leaves them. */
export function formatOfferedFile(major: string, o: Offered): string {
  const out = [
    `# What FFmpeg ${major}'s configure offers to turn on, read from its newest release (${o.release}): every external`,
    "# library and hardware option (configure's library lists and --help's library section), with its licence class.",
    '# Each is an option of ffmpeg/<major>.yml or an entry of ffmpeg/unsupported.yml (tests/ffmpeg-coverage.test.ts).',
    '# `flags:` is every other name configure takes after --enable-/--disable-. Written by the nightly support check',
    '# (scripts/ffmpeg-support.ts --write): not edited by hand.',
    `release: ${o.release}`,
    'options:',
    ...Object.entries(o.options)
      .sort(byName)
      .map(
        ([n, v]) =>
          `  ${n}: { lists: [${v.lists.join(', ')}]${v.license ? `, license: ${v.license}` : ''} }`,
      ),
    ...(o.flags.length ? ['flags:', ...o.flags.map((f) => `  - ${f}`)] : ['flags: []']),
  ];
  return `${out.join('\n')}\n`;
}

const offeredSchema = z.strictObject({
  release: z.string(),
  options: z.record(
    z.string(),
    z.strictObject({
      lists: z.array(z.enum(LIST_NAMES)).min(1),
      license: z.enum(['gpl', 'version3', 'gplv3', 'nonfree']).optional(),
    }),
  ),
  flags: z.array(z.string()),
});

/** A ffmpeg/offered/<major>.yml's contents; a malformed file throws, saying what is wrong. */
export function parseOfferedFile(text: string, label: string): Offered {
  const parsed = offeredSchema.safeParse(parseYaml(text, label));
  if (!parsed.success) {
    throw new Error(`${label}: ${formatIssues(parsed.error).join('; ')}`);
  }
  const { release, options, flags } = parsed.data;
  return {
    release,
    options: Object.fromEntries(
      Object.entries(options).map(([n, v]) => [
        n,
        { lists: v.lists, ...(v.license ? { license: v.license } : {}) },
      ]),
    ),
    flags,
  };
}

const REASONS = [
  'pending',
  'sdk-not-redistributable',
  'needs-hardware-sdk',
  'platform-not-built',
  'deprecated-upstream',
  'alternative-built',
  // the library builds only as shared libraries (and their private ones), and every library here links in statically
  'shared-only',
  'upstream-incompatible',
] as const;
type Reason = (typeof REASONS)[number];

const entrySchema = z.strictObject({
  reason: z.enum(REASONS),
  note: z.string().min(1),
  // pending: the open issue tracking it, and its section of that issue (a key of batches:)
  issue: z
    .string()
    .regex(/^[1-9]\d*$/, 'expected an issue number')
    .transform(Number)
    .optional(),
  batch: z.string().optional(),
  // alternative-built: the engine option that does the job
  instead: z.string().optional(),
  // the majors it is for (default: every major that offers it)
  majors: z.array(z.string().regex(/^\d+$/, 'expected a major, like 9')).min(1).optional(),
});
type UnsupportedEntry = z.output<typeof entrySchema>;

const unsupportedSchema = z.strictObject({
  batches: z.record(z.string(), z.string()).default({}),
  options: z.record(z.string(), entrySchema),
});
export type Unsupported = z.output<typeof unsupportedSchema>;

/** What is wrong with one entry beyond its shape. */
function entryErrors(name: string, e: UnsupportedEntry, batches: Record<string, string>): string[] {
  return [
    ...(e.reason === 'pending' && e.issue === undefined
      ? [`${name}: a pending entry needs issue: (the open issue tracking it)`]
      : []),
    ...(e.reason === 'alternative-built' && !e.instead
      ? [`${name}: an alternative-built entry needs instead: (the option that does its job)`]
      : []),
    ...(e.batch !== undefined && !(e.batch in batches)
      ? [`${name}: batch ${e.batch} isn't one of batches:`]
      : []),
  ];
}

/** ffmpeg/unsupported.yml's contents; a malformed file throws, saying what is wrong. */
export function parseUnsupported(text: string, label = 'ffmpeg/unsupported.yml'): Unsupported {
  const parsed = unsupportedSchema.safeParse(parseYaml(text, label));
  const errors = parsed.success
    ? Object.entries(parsed.data.options).flatMap(([n, e]) =>
        entryErrors(n, e, parsed.data.batches),
      )
    : formatIssues(parsed.error);
  if (!parsed.success || errors.length) {
    throw new Error(errors.map((m) => `${label}: ${m}`).join('\n'));
  }
  return parsed.data;
}

/** A name configure takes after --enable-, from a flag: --enable-libfdk-aac is libfdk_aac. */
const flagName = (flag: string): string | undefined =>
  /^--(?:enable|disable)-([a-z0-9_-]+)$/.exec(flag)?.[1]?.replaceAll('-', '_');

/** Whether `option` builds on platform `p`: its library there builds there, or it is built in with none. */
function buildsOn(data: EngineData, o: OptionInfo, p: string): boolean {
  const lib = optionRecipe(o, p);
  if (!lib) {
    return o.builtin;
  }
  const recipe = data.recipes.get(lib);
  return recipe !== undefined && expandPlatforms(recipe.platforms).includes(p);
}

/**
 * The flags an option turns on, as the build would: on every platform the engine builds where the option applies and
 * builds, its own configure:, else its library's there, else --enable-<option>. Undefined: it builds nowhere.
 */
function flagsOf(data: EngineData, o: OptionInfo): string[] | undefined {
  const where = [...data.platforms.keys()].filter(
    (p) => (!o.platforms || platformMatches(p, o.platforms)) && buildsOn(data, o, p),
  );
  if (!where.length) {
    return undefined;
  }
  const flags = where.flatMap((p) => {
    const lib = optionRecipe(o, p);
    return [
      ...(o.configure ??
        (lib ? valuesOn(data.recipes.get(lib)!, 'configure', p) : [`--enable-${o.name}`])),
      ...(lib ? linkageFlagsOf(data, [lib], p) : []),
    ];
  });
  return [...new Set(flags)];
}

/** One class for the licence switches a set of classes needs: gpl and version3 together are gplv3. */
export function combinedClass(classes: LicenseClass[]): LicenseClass | '' {
  const on = new Set(classes.flatMap((c) => CLASS_NEEDS[c]));
  if (on.has('nonfree')) {
    return 'nonfree';
  }
  if (on.has('gpl') && on.has('version3')) {
    return 'gplv3';
  }
  return (['gpl', 'version3'] as const).find((c) => on.has(c)) ?? '';
}

/** What one major's coverage comes to. */
export interface MajorCounts {
  release: string;
  offered: number;
  supported: number;
  pending: number;
  notPlanned: Partial<Record<Reason, number>>;
}

type ProblemKind = 'data' | 'unaccounted' | 'entry' | 'recipes';
export interface CoverageProblem {
  kind: ProblemKind;
  name?: string; // for unaccounted: the configure name, and the major offering it
  major?: string;
  text: string;
}

const KIND_ORDER: ProblemKind[] = ['data', 'unaccounted', 'entry', 'recipes'];

/** One option of a major against that major's configure: the names it turns on, and what is wrong with it. */
function checkOption(
  data: EngineData,
  major: string,
  o: OptionInfo,
  offered: Offered | undefined,
): { turnsOn: string[]; problems: CoverageProblem[] } {
  const file = `ffmpeg/${major}.yml`;
  const flags = flagsOf(data, o);
  if (!flags) {
    const lib = o.libraries.map((l) => l.name).join(', ');
    const text = lib
      ? `${file}'s option ${o.name}: its library ${lib} builds on no platform the engine builds (platforms.yml) where the option applies`
      : `${file}'s option ${o.name} applies to no platform the engine builds (platforms.yml)`;
    return { turnsOn: [], problems: [{ kind: 'data', text }] };
  }
  if (!offered) {
    return { turnsOn: [], problems: [] };
  }
  // --enable-x / --disable-x; --enable-decoder=... and --extra-libs=... aren't configure's options
  const named = flags.filter((f) => flagName(f) !== undefined);
  const unknown = named.filter((f) => {
    const n = flagName(f)!;
    return !(n in offered.options) && !offered.flags.includes(n);
  });
  const turnsOn = named
    .filter((f) => f.startsWith('--enable-'))
    .map((f) => flagName(f)!)
    .filter((n) => n in offered.options);
  const problems: CoverageProblem[] = unknown.map((f) => ({
    kind: 'data',
    text: `${file}'s option ${o.name} turns on ${f}, which FFmpeg ${offered.release}'s configure doesn't take`,
  }));
  const classed = turnsOn.filter((n) => offered.options[n]!.license);
  const need = combinedClass(classed.map((n) => offered.options[n]!.license!));
  const own = o.ffmpegLicense ?? '';
  if (turnsOn.length && need !== own) {
    const which = classed.length
      ? ` (${classed.map((n) => `${n} ${offered.options[n]!.license!}`).join(', ')})`
      : '';
    problems.push({
      kind: 'data',
      text: `${file}'s option ${o.name} has ${own ? `ffmpeg-license: ${own}` : 'no ffmpeg-license:'}, but configure's classes for what it turns on${which} make it ${need || 'none'}`,
    });
  }
  return { turnsOn, problems };
}

/** A major's offered file: there, and read at the major's newest release. */
function offeredFileProblems(
  data: EngineData,
  major: string,
  o: Offered | undefined,
): CoverageProblem[] {
  const newest = data.ffmpeg.get(major)!.releases.at(-1);
  if (!o) {
    return [
      {
        kind: 'data',
        text: `ffmpeg/offered/${major}.yml is missing: run \`node scripts/ffmpeg-support.ts --write\` to write it`,
      },
    ];
  }
  return newest && o.release !== newest
    ? [
        {
          kind: 'data',
          text: `ffmpeg/offered/${major}.yml is from FFmpeg ${o.release}, not ffmpeg/${major}.yml's newest release ${newest}: run \`node scripts/ffmpeg-support.ts --write\``,
        },
      ]
    : [];
}

/** An entry is for the majors it names, else for every major that offers it. */
const entryFor = (
  name: string,
  e: UnsupportedEntry,
  major: string,
  offered: Map<string, Offered | undefined>,
): boolean => (e.majors ? e.majors.includes(major) : name in (offered.get(major)?.options ?? {}));

/** Each offered option of a major: supported, listed (pending or not planned), or unaccounted for. */
function account(
  major: string,
  o: Offered,
  supported: Map<string, string>,
  u: Unsupported,
  offered: Map<string, Offered | undefined>,
): { counts: MajorCounts; problems: CoverageProblem[] } {
  const counts: MajorCounts = {
    release: o.release,
    offered: Object.keys(o.options).length,
    supported: 0,
    pending: 0,
    notPlanned: {},
  };
  const problems: CoverageProblem[] = [];
  for (const [n, v] of Object.entries(o.options).sort(byName)) {
    const e = u.options[n];
    const entry = e && entryFor(n, e, major, offered) ? e : undefined;
    if (supported.has(n)) {
      counts.supported++;
    } else if (entry?.reason === 'pending') {
      counts.pending++;
    } else if (entry) {
      counts.notPlanned[entry.reason] = (counts.notPlanned[entry.reason] ?? 0) + 1;
    } else {
      problems.push({
        kind: 'unaccounted',
        name: n,
        major,
        text: `FFmpeg ${major} (${o.release}) offers --enable-${n.replaceAll('_', '-')}${v.license ? ` (${v.license})` : ''}, but no option of ffmpeg/${major}.yml turns it on and ffmpeg/unsupported.yml doesn't list it`,
      });
    }
  }
  return { counts, problems };
}

/** The entries of ffmpeg/unsupported.yml that are stale or wrong. */
function entryProblems(
  data: EngineData,
  u: Unsupported,
  offered: Map<string, Offered | undefined>,
  supportedBy: Map<string, Map<string, string>>,
): CoverageProblem[] {
  const at = 'ffmpeg/unsupported.yml';
  const majors = [...data.ffmpeg.keys()];
  const known = majors.filter((m) => offered.get(m));
  return Object.entries(u.options)
    .sort(byName)
    .flatMap(([n, e]): CoverageProblem[] => {
      if (!e.majors && !known.some((m) => n in offered.get(m)!.options)) {
        const releases = known.map((m) => offered.get(m)!.release).join(', ');
        return [
          {
            kind: 'entry',
            text: `${at} lists ${n}, but no FFmpeg major the engine knows offers it (${releases}): remove the entry`,
          },
        ];
      }
      const named = (e.majors ?? []).flatMap((m): string[] => {
        const o = offered.get(m);
        if (!data.ffmpeg.has(m)) {
          return [
            `${at} lists ${n} for FFmpeg ${m} (majors:), which the engine has no ffmpeg/${m}.yml for`,
          ];
        }
        return o && !(n in o.options)
          ? [
              `${at} lists ${n} for FFmpeg ${m} (majors:), but FFmpeg ${o.release} doesn't offer it: take ${m} out of its majors:`,
            ]
          : [];
      });
      const perMajor = majors
        .filter((m) => entryFor(n, e, m, offered))
        .flatMap((m) => {
          const option = supportedBy.get(m)?.get(n);
          return [
            ...(option
              ? [
                  `${at} lists ${n}, but ffmpeg/${m}.yml's option ${option} turns it on: remove the entry, or give it majors: without ${m}`,
                ]
              : []),
            ...(e.instead && !optionsOf(data, m).has(e.instead)
              ? [`${at}: ${n}'s instead: ${e.instead} isn't an option of ffmpeg/${m}.yml`]
              : []),
          ];
        });
      return [...named, ...perMajor].map((text) => ({ kind: 'entry', text }));
    });
}

/** Recipes no option builds: not an option's library, nor needed or used by a recipe that is. */
function orphanProblems(data: EngineData): CoverageProblem[] {
  const reached = new Set<string>();
  const visit = (r: string) => {
    if (!reached.has(r)) {
      reached.add(r);
      const recipe = data.recipes.get(r);
      [...(recipe?.needs ?? []), ...(recipe?.uses ?? [])].forEach((d) => {
        visit(d.name);
      });
    }
  };
  for (const m of data.ffmpeg.keys()) {
    for (const o of optionsOf(data, m).values()) {
      o.libraries.forEach((l) => {
        visit(l.name);
      });
    }
  }
  return [...data.recipes.keys()]
    .filter((r) => !reached.has(r))
    .sort()
    .map((r) => ({
      kind: 'recipes',
      text: `recipes/${r} is built for no option: no option of any ffmpeg/<major>.yml needs it, and no recipe needs or uses it`,
    }));
}

/** Every problem with what the engine's data supports of what configure offers, and each major's counts. */
export function coverage(
  data: EngineData,
  offered: Map<string, Offered | undefined>,
  unsupported: Unsupported,
): { problems: CoverageProblem[]; counts: Map<string, MajorCounts> } {
  const problems: CoverageProblem[] = [];
  const counts = new Map<string, MajorCounts>();
  const supportedBy = new Map<string, Map<string, string>>(); // major -> configure name -> option
  for (const major of data.ffmpeg.keys()) {
    const o = offered.get(major);
    problems.push(...offeredFileProblems(data, major, o));
    const supported = new Map<string, string>();
    supportedBy.set(major, supported);
    for (const info of [...optionsOf(data, major).values()].filter((x) => !alwaysBuilt(x))) {
      const checked = checkOption(data, major, info, o);
      for (const n of checked.turnsOn) {
        supported.set(n, info.name);
      }
      problems.push(...checked.problems);
    }
    if (o) {
      const a = account(major, o, supported, unsupported, offered);
      counts.set(major, a.counts);
      problems.push(...a.problems);
    }
  }
  problems.push(...entryProblems(data, unsupported, offered, supportedBy), ...orphanProblems(data));
  return {
    problems: KIND_ORDER.flatMap((k) => problems.filter((p) => p.kind === k)),
    counts,
  };
}

const WHAT_TO_DO: Record<ProblemKind, (p: CoverageProblem[]) => string[]> = {
  data: () => [
    'Fix the data as each line says. ffmpeg/offered/ is written by `node scripts/ffmpeg-support.ts --write`, never by hand.',
  ],
  unaccounted: (ps) => [
    'Each of these is an option FFmpeg offers that the engine has no answer for. For each, either:',
    '- support it: a recipe whose configure: turns it on, and an option in ffmpeg/<major>.yml that needs the recipe',
    '  (or a `builtin: true` option when the system provides it); or',
    '- list it in ffmpeg/unsupported.yml with a reason, e.g.',
    ...ps.map((p) => `    ${p.name ?? ''}: { reason: pending, issue: <n>, note: <what it is> }`),
    '  (reasons: pending with the open issue tracking it, sdk-not-redistributable, needs-hardware-sdk,',
    '  platform-not-built, deprecated-upstream, alternative-built with instead: <option>, shared-only, upstream-incompatible).',
    'DEVELOPMENT.md, "Adding support for an FFmpeg option", has the steps.',
  ],
  entry: () => ['Remove or correct these entries of ffmpeg/unsupported.yml as each line says.'],
  recipes: () => [
    'Give each recipe an option (provides: and an option in ffmpeg/<major>.yml) or a recipe that needs it, or remove it.',
  ],
};

/** The problems as a contributor reads them: what is wrong, then what to do. Empty when there are none. */
export function formatCoverage(problems: CoverageProblem[]): string {
  if (!problems.length) {
    return '';
  }
  const out = [
    `${problems.length} problem${problems.length > 1 ? 's' : ''} with what the engine supports of FFmpeg's configure:`,
  ];
  for (const kind of KIND_ORDER) {
    const these = problems.filter((p) => p.kind === kind);
    if (these.length) {
      out.push('', ...these.map((p) => `- ${p.text}`), '', ...WHAT_TO_DO[kind](these));
    }
  }
  return `${out.join('\n')}\n`;
}

/** Each major's counts, as a markdown table. */
export function formatCounts(counts: Map<string, MajorCounts>): string {
  const rows = [...counts].map(([major, c]) => {
    const reasons = Object.entries(c.notPlanned);
    const notPlanned = reasons.reduce((n, [, k]) => n + k, 0);
    const detail = reasons.length ? ` (${reasons.map(([r, k]) => `${r} ${k}`).join(', ')})` : '';
    return `| ${major} (${c.release}) | ${c.offered} | ${c.supported} | ${c.pending} | ${notPlanned}${detail} |`;
  });
  return [
    '| FFmpeg | offered | supported | pending | not planned |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

/** The pending entries as an issue's checklist, by batch, then the entries not planned with their reasons. */
export function issueChecklist(u: Unsupported): string {
  const entries = Object.entries(u.options);
  const pending = entries.filter(([, e]) => e.reason === 'pending');
  const sections: [string, [string, UnsupportedEntry][]][] = [
    ...Object.entries(u.batches).map(([b, title]): [string, [string, UnsupportedEntry][]] => [
      `${b}. ${title}`,
      pending.filter(([, e]) => e.batch === b),
    ]),
    ['Other', pending.filter(([, e]) => e.batch === undefined)],
  ];
  const rest = entries.filter(([, e]) => e.reason !== 'pending');
  return [
    ...sections
      .filter(([, these]) => these.length)
      .flatMap(([title, these]) => [
        `### ${title}`,
        '',
        ...these.map(([n, e]) => `- [ ] ${e.note}: \`${n}\``),
        '',
      ]),
    ...(rest.length
      ? ['### Not planned', '', ...rest.map(([n, e]) => `- \`${n}\` (${e.reason}): ${e.note}`), '']
      : []),
  ].join('\n');
}

/** The engine's ffmpeg/offered/<major>.yml (undefined where there is none) and ffmpeg/unsupported.yml. */
export function readCoverageData(data: EngineData): {
  offered: Map<string, Offered | undefined>;
  unsupported: Unsupported;
} {
  const offered = new Map<string, Offered | undefined>();
  for (const major of data.ffmpeg.keys()) {
    const file = offeredFilePath(data.root, major);
    offered.set(
      major,
      existsSync(file)
        ? parseOfferedFile(readFileSync(file, 'utf8'), `ffmpeg/offered/${major}.yml`)
        : undefined,
    );
  }
  const unsupported = join(data.root, 'ffmpeg', 'unsupported.yml');
  return { offered, unsupported: parseUnsupported(readFileSync(unsupported, 'utf8')) };
}
