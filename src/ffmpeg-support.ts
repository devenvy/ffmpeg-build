// What FFmpeg itself offers, read from its configure script, against what the engine's ffmpeg/<major>.yml says: the
// nightly support check (scripts/ffmpeg-support.ts, .github/workflows/ffmpeg-support.yml). Releases are pure data and
// are corrected from upstream's tags; new or changed options are reported for a person to decide.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type EngineData, knownMajors, optionsOf, valuesOn } from './engine-data.ts';
import {
  componentsFilePath,
  type ComponentsRead,
  formatComponentsFile,
  parseComponentsFile,
} from './ffmpeg-components.ts';
import {
  combinedClass,
  coverage,
  formatOfferedFile,
  type Offered,
  offeredFilePath,
  parseOfferedFile,
  parseUnsupported,
  type Unsupported,
} from './ffmpeg-coverage.ts';
import { compareVersions } from './versions.ts';

/** A file's text, or undefined when there is none (read once: no exists-then-read race). */
function readIfThere(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw e;
  }
}
export type LicenseClass = 'gpl' | 'version3' | 'gplv3' | 'nonfree' | '';

/** configure's external and hwaccel library options, each with its licence class ('' for none). */
export function parseConfigure(text: string): Map<string, LicenseClass> {
  const lists = new Map<string, string[]>();
  for (const m of text.matchAll(/^([A-Z0-9_]+_LIST)="\n([\s\S]*?)^"/gm)) {
    lists.set(m[1]!, m[2]!.split(/\s+/).filter(Boolean));
  }
  const expand = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) {
      return [];
    }
    seen.add(name);
    return (lists.get(name) ?? []).flatMap((w) =>
      w.startsWith('$') ? expand(w.slice(1), seen) : [w],
    );
  };
  const classOf = new Map<string, LicenseClass>();
  for (const [list, cls] of [
    ['EXTERNAL_LIBRARY_GPL_LIST', 'gpl'],
    ['EXTERNAL_LIBRARY_NONFREE_LIST', 'nonfree'],
    ['EXTERNAL_LIBRARY_VERSION3_LIST', 'version3'],
    ['EXTERNAL_LIBRARY_GPLV3_LIST', 'gplv3'],
    ['HWACCEL_LIBRARY_NONFREE_LIST', 'nonfree'],
  ] as const) {
    for (const o of expand(list)) {
      classOf.set(o, cls);
    }
  }
  const all = [
    'EXTERNAL_LIBRARY_LIST',
    'EXTERNAL_AUTODETECT_LIBRARY_LIST',
    'HWACCEL_LIBRARY_LIST',
    'HWACCEL_AUTODETECT_LIBRARY_LIST',
  ].flatMap((l) => expand(l));
  return new Map([...new Set(all)].sort().map((o) => [o, classOf.get(o) ?? '']));
}

/** The configure names an engine option turns on: `--enable-<name>` flags of its own, its recipe's, or its name. */
function configureNames(data: EngineData, major: string): Map<string, string> {
  const names = new Map<string, string>(); // configure name -> engine option
  for (const o of optionsOf(data, major).values()) {
    const recipe = o.libraries[0]?.name;
    const lib = recipe ? data.recipes.get(recipe) : undefined;
    let flags = o.configure ?? [`--enable-${o.name}`];
    if (!o.configure && recipe) {
      flags = lib ? valuesOn(lib, 'configure') : [];
    }
    for (const f of flags) {
      // configure takes --enable-libfdk-aac for libfdk_aac
      const m = /^--enable-([a-z0-9_-]+)$/.exec(f);
      if (m) {
        names.set(m[1]!.replaceAll('-', '_'), o.name);
      }
    }
  }
  return names;
}

export interface SupportReport {
  major: string;
  releases: { was: string[]; now: string[] };
  newOptions: { name: string; license: LicenseClass }[]; // in the newest release's configure, not in the previous one's
  gone: string[]; // engine options whose configure name the previous release had and the newest no longer has
  reclassed: { option: string; data: string; configure: LicenseClass }[];
  /** the release whose offered options differ from ffmpeg/offered/<major>.yml's (absent when they match) */
  offered?: string;
  /** what the newest release offers that no option turns on and ffmpeg/unsupported.yml doesn't list */
  notAccounted?: { name: string; license: string }[];
  /** the release whose components differ from ffmpeg/components/<major>.yml's (absent when they match) */
  components?: string;
  /** components whose runtime name wasn't found in the sources (their configure name is kept) */
  unread?: string[];
}

const DATA_CLASS: Record<LicenseClass, string[]> = {
  '': [''],
  gpl: ['gpl'],
  version3: ['version3'],
  gplv3: ['gplv3'],
  nonfree: ['nonfree'],
};

/**
 * One major's report: its releases as upstream has them, and the newest release's configure against the previous
 * release's (new options) and against the engine's data (gone, reclassed).
 */
export function supportReport(
  data: EngineData,
  major: string,
  upstream: string[],
  newest: Map<string, LicenseClass>,
  previous: Map<string, LicenseClass> | undefined,
): SupportReport {
  const was = data.ffmpeg.get(major)?.releases ?? [];
  const now = upstream.filter((v) => v.split('.')[0] === major).sort(compareVersions);
  const names = configureNames(data, major);
  // new: in the newest configure, not in the previous one, and not already in the data (a recipe added early)
  const newOptions = previous
    ? [...newest]
        .filter(([n]) => !previous.has(n) && !names.has(n))
        .map(([name, license]) => ({ name, license }))
    : [];
  // gone: a name the data turns on that the previous release's configure had and the newest's lacks, whatever its prefix
  const gone = previous
    ? [...names].filter(([n]) => previous.has(n) && !newest.has(n)).map(([, o]) => o)
    : [];
  const reclassed: SupportReport['reclassed'] = [];
  for (const o of optionsOf(data, major).values()) {
    // every name it turns on that configure has: the class they need together (rkmpp's recipe turns on libdrm too)
    const its = [...names].filter(([n, opt]) => opt === o.name && newest.has(n));
    const cls = its.length
      ? combinedClass(its.map(([n]) => newest.get(n)!).filter((c) => c !== ''))
      : undefined;
    const dataClass = o.ffmpegLicense ?? '';
    if (cls !== undefined && !o.builtin && !DATA_CLASS[cls].includes(dataClass)) {
      reclassed.push({ option: o.name, data: dataClass || 'none', configure: cls });
    }
  }
  return { major, releases: { was, now }, newOptions, gone: [...new Set(gone)].sort(), reclassed };
}

/** Rewrites ffmpeg/<major>.yml's `releases:` line in place (comments and everything else stay). */
export function writeReleases(dataRoot: string, major: string, releases: string[]): boolean {
  const file = join(dataRoot, 'ffmpeg', `${major}.yml`);
  const text = readFileSync(file, 'utf8');
  // on one line, or wrapped over several (as Prettier writes a long list); written back on one line for Prettier to
  // wrap again
  const next = text.replace(/^releases:\s*\[[^\]]*\]/m, `releases: [${releases.join(', ')}]`);
  if (next === text) {
    return false;
  }
  writeFileSync(file, next);
  return true;
}

/** Markdown for the PR body or the run summary. */
export function formatSupport(
  reports: SupportReport[],
  majors: string[],
  applied = false,
  closed: string[] = [],
): string {
  const out = ['# FFmpeg support check', ''];
  for (const r of reports) {
    out.push(`## FFmpeg ${r.major}`);
    const added = r.releases.now.filter((v) => !r.releases.was.includes(v));
    const dropped = r.releases.was.filter((v) => !r.releases.now.includes(v));
    out.push(
      added.length || dropped.length
        ? `- releases: ${[...added.map((v) => `+${v}`), ...dropped.map((v) => `-${v}`)].join(', ')} (${applied ? 'applied' : 'run with --write to apply'})`
        : '- releases: up to date',
    );
    if (r.newOptions.length) {
      out.push(
        `- **new in ${String(r.releases.now.at(-1))}** (a person decides; add a recipe and an option, or leave out): ${r.newOptions.map((o) => `\`${o.name}\`${o.license ? ` (${o.license})` : ''}`).join(', ')}`,
      );
    }
    if (r.gone.length) {
      out.push(
        `- **gone from configure**, still in the data: ${r.gone.map((g) => `\`${g}\``).join(', ')}`,
      );
    }
    if (r.components) {
      out.push(
        `- components: from ${r.components} (${applied ? 'applied' : 'run with --write to apply'})`,
      );
    }
    if (r.offered) {
      out.push(
        `- offered options: from ${r.offered} (${applied ? 'applied' : 'run with --write to apply'})`,
      );
    }
    if (r.notAccounted?.length) {
      out.push(
        `- **not accounted for** (CI fails until each is supported, or listed in ffmpeg/unsupported.yml): ${r.notAccounted.map((o) => `\`${o.name}\`${o.license ? ` (${o.license})` : ''}`).join(', ')}`,
      );
    }
    if (r.unread?.length) {
      out.push(`- **runtime names not read** (configure's used): ${r.unread.join(', ')}`);
    }
    for (const c of r.reclassed) {
      out.push(
        `- **licence class changed:** \`${c.option}\` is ${c.data} in the data, ${c.configure} in configure`,
      );
    }
    out.push('');
  }
  out.push(
    ...closed.map(
      (c) => `${c}
`,
    ),
  );
  if (majors.length) {
    out.push(
      `**New FFmpeg major${majors.length > 1 ? 's' : ''} ${majors.join(', ')}**: add ffmpeg/<major>.yml to support it (not done automatically).`,
      '',
    );
  }
  return `${out.join('\n')}\n`;
}

/** Majors upstream has that the engine's data doesn't. */
export function newMajors(data: EngineData, upstream: string[]): string[] {
  const known = new Set(knownMajors(data));
  const top = Math.max(...[...known].map(Number));
  return [...new Set(upstream.map((v) => v.split('.')[0]!))]
    .filter((m) => !known.has(m) && Number(m) > top)
    .sort((a, b) => Number(a) - Number(b));
}

/** The check couldn't be made (upstream unreadable, the data not in the expected shape): exit 2. */
export class SupportError extends Error {}

/**
 * The whole check: each handled major's report from upstream's release versions and the configure of its newest
 * release (and the one before), with --write correcting ffmpeg/<major>.yml's releases. An empty `upstream` is a
 * failure to read FFmpeg's tags, never "nothing changed".
 */
export async function supportCheck(o: {
  data: EngineData;
  dataRoot: string;
  upstream: string[];
  configureOf: (version: string) => Promise<Map<string, LicenseClass>>;
  /** each release's components (FFmpeg's sources at its tag); without it the component lists aren't checked */
  componentsOf?: (version: string) => Promise<ComponentsRead>;
  /** what each release's configure offers to turn on; without it ffmpeg/offered/ isn't checked */
  offeredOf?: (version: string) => Promise<Omit<Offered, 'release'>>;
  /** whether an issue is open (undefined: couldn't tell); without it pending entries' issues aren't checked */
  issueOpen?: (issue: number) => Promise<boolean | undefined>;
  write: boolean;
}): Promise<string> {
  if (!o.upstream.length) {
    throw new SupportError(
      "FFmpeg's release versions couldn't be read (upstream gave none); nothing was checked",
    );
  }
  const reports: SupportReport[] = [];
  const offered = new Map<string, Offered | undefined>();
  const releasesOf = (major: string): string[] =>
    o.upstream.filter((v) => v.split('.')[0] === major).sort(compareVersions);
  const majors = [...o.data.ffmpeg.keys()]
    .sort((a, b) => Number(a) - Number(b))
    .filter((major) => releasesOf(major).length);
  for (const major of majors) {
    const releases = releasesOf(major);
    // the release before the newest
    const previous = releases.slice(0, -1).at(-1);
    const report = supportReport(
      o.data,
      major,
      o.upstream,
      await o.configureOf(releases.at(-1)!),
      previous ? await o.configureOf(previous) : undefined,
    );
    if (o.componentsOf) {
      const newest = releases.at(-1)!;
      const { unread, ...read } = await o.componentsOf(newest);
      if (unread.length) {
        report.unread = unread;
      }
      const file = componentsFilePath(o.dataRoot, major);
      const text = readIfThere(file);
      const kept =
        text === undefined
          ? undefined
          : parseComponentsFile(text, `ffmpeg/components/${major}.yml`);
      const next = formatComponentsFile(major, { release: newest, ...read });
      if (!kept || formatComponentsFile(major, kept) !== next) {
        report.components = newest;
        if (o.write) {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, next);
        }
      }
    }
    if (o.offeredOf) {
      const newest = releases.at(-1)!;
      const read: Offered = { release: newest, ...(await o.offeredOf(newest)) };
      const file = offeredFilePath(o.dataRoot, major);
      const text = readIfThere(file);
      const next = formatOfferedFile(major, read);
      offered.set(major, read);
      if (text === undefined || formatOfferedFile(major, parseOfferedFile(text, file)) !== next) {
        report.offered = newest;
        if (o.write) {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, next);
        }
      }
    }
    reports.push(report);
    if (
      o.write &&
      report.releases.now.join() !== report.releases.was.join() &&
      !writeReleases(o.dataRoot, major, report.releases.now)
    ) {
      throw new SupportError(
        `ffmpeg/${major}.yml: no \`releases: [...]\` list to rewrite; correct it by hand to [${report.releases.now.join(', ')}]`,
      );
    }
  }
  const unsupported = readUnsupported(o.dataRoot);
  if (o.offeredOf) {
    const { problems } = coverage(o.data, offered, unsupported);
    for (const r of reports) {
      const these = problems.filter((p) => p.kind === 'unaccounted' && p.major === r.major);
      if (these.length) {
        r.notAccounted = these.map((p) => ({
          name: p.name!,
          license: offered.get(r.major)?.options[p.name!]?.license ?? '',
        }));
      }
    }
  }
  const closed = o.issueOpen ? await closedIssues(unsupported, o.issueOpen) : [];
  return formatSupport(reports, newMajors(o.data, o.upstream), o.write, closed);
}

/** ffmpeg/unsupported.yml, or no entries when there is none. */
function readUnsupported(dataRoot: string): Unsupported {
  const text = readIfThere(join(dataRoot, 'ffmpeg', 'unsupported.yml'));
  return text === undefined ? { batches: {}, options: {} } : parseUnsupported(text);
}

/** A line for each closed issue that pending entries still point at. */
async function closedIssues(
  u: Unsupported,
  issueOpen: (issue: number) => Promise<boolean | undefined>,
): Promise<string[]> {
  const byIssue = new Map<number, string[]>();
  for (const [name, e] of Object.entries(u.options)) {
    if (e.reason === 'pending' && e.issue !== undefined) {
      byIssue.set(e.issue, [...(byIssue.get(e.issue) ?? []), name]);
    }
  }
  const lines: string[] = [];
  for (const [issue, names] of byIssue) {
    if ((await issueOpen(issue)) === false) {
      lines.push(
        `**pending issue closed**: #${issue} is closed, but ffmpeg/unsupported.yml has pending entries pointing at it: ${names.join(', ')}`,
      );
    }
  }
  return lines;
}
