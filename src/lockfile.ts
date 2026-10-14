import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { displayPath } from './profile.ts';
import { formatIssues, name, text } from './schema/common.ts';
import { type Condition, conditionShape } from './schema/profile.ts';
import { parseYaml, YamlError } from './yaml.ts';

export const LOCK_FILE = 'ffmpeg.lock';

interface LockedPin {
  name: string;
  version: string;
  cond?: Condition;
}
export interface LockedProfile {
  ffmpeg: Record<string, string>;
  libraries: Record<string, string>;
  pinned: LockedPin[];
  pins?: LockPins;
}
export interface Lock {
  engine: string;
  profiles: Record<string, LockedProfile>;
}

export class LockError extends Error {}

const RECOVER =
  'ffmpeg.lock is written by ffmpeg-build: resolve the conflict, or delete it and run ffmpeg-build lock';

const pinnedEntry = z
  .record(name, z.strictObject({ ...conditionShape, version: text }))
  .refine((o) => Object.keys(o).length === 1, {
    error: 'each pinned entry names exactly one library',
  })
  .transform((o): LockedPin => {
    const [library, { version, ...cond }] = Object.entries(o)[0]!;
    return Object.keys(cond).length ? { name: library, version, cond } : { name: library, version };
  });

const lockSchema = z.strictObject({
  engine: text,
  profiles: z
    .record(
      name,
      z.strictObject({
        ffmpeg: z.record(text, text),
        libraries: z.record(name, text).default({}),
        pinned: z.array(pinnedEntry).default([]),
      }),
    )
    .default({}),
});

export function parseLock(source: string, file: string): Lock {
  let raw: unknown;
  try {
    raw = parseYaml(source, file);
  } catch (e) {
    if (e instanceof YamlError) {
      throw new LockError(`${e.message} (${RECOVER})`);
    }
    throw e;
  }
  const parsed = lockSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new LockError(
      `${formatIssues(parsed.error)
        .map((m) => `${file}: ${m}`)
        .join('\n')}\n(${RECOVER})`,
    );
  }
  return parsed.data;
}

/** The lock at `path`, or undefined when there is none yet. */
export function readLock(path: string): Lock | undefined {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw e;
  }
  return parseLock(source, displayPath(path));
}

const HEADER =
  '# ffmpeg.lock - written only by `ffmpeg-build update` / `ffmpeg-build lock`. Do not edit.';
const plain = (v: string) => (/^[\w.+-]+$/.test(v) ? v : JSON.stringify(v));

function condText(cond: Condition): string {
  // a key the condition doesn't set can still be there, holding undefined
  return Object.entries<string[] | undefined>(cond)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: [${v!.map(plain).join(', ')}]`)
    .join(', ');
}

/** Fixed layout: profiles and libraries sorted, pins in profile order, so diffs show only real changes. */
export function formatLock(lock: Lock): string {
  const out = [HEADER, `engine: ${plain(lock.engine)}`];
  const profiles = Object.keys(lock.profiles).sort();
  out.push(profiles.length ? 'profiles:' : 'profiles: {}');
  for (const profile of profiles) {
    const p = lock.profiles[profile]!;
    out.push(`  ${profile}:`);
    out.push(
      `    ffmpeg: { ${Object.entries(p.ffmpeg)
        .map(([series, v]) => `${JSON.stringify(series)}: ${plain(v)}`)
        .join(', ')} }`,
    );
    const libraries = Object.keys(p.libraries).sort();
    if (libraries.length) {
      out.push('    libraries:');
      for (const l of libraries) {
        out.push(`      ${l}: ${plain(p.libraries[l]!)}`);
      }
    }
    if (p.pinned.length) {
      out.push('    pinned:');
      for (const pin of p.pinned) {
        out.push(
          `      - ${pin.name}: { version: ${plain(pin.version)}${pin.cond ? `, ${condText(pin.cond)}` : ''} }`,
        );
      }
    }
  }
  return `${out.join('\n')}\n`;
}

// ---- the folder lock (targets): one version per FFmpeg series and per library, shared by every target ----------

/** What a locked version stands for: a git tag's commit, or a tarball's sha256. */
export interface SourcePin {
  commit?: string;
  sha256?: string;
}
/** The pins, by FFmpeg series (its tarball) and by library. A branch library has none: its version is a commit. */
export interface LockPins {
  ffmpeg: Record<string, SourcePin>;
  libraries: Record<string, SourcePin>;
}

/**
 * ffmpeg.lock: one FFmpeg release per series, one version per library, and (since sources are pinned) the content
 * each stands for. `pins` is absent in a lock written before pins, which still builds unpinned.
 */
export interface FolderLock {
  engine: string;
  ffmpeg: Record<string, string>;
  libraries: Record<string, string>;
  pins?: LockPins;
}

const sha256Text = z
  .string({ error: 'expected a sha256' })
  .regex(/^[0-9a-f]{64}$/, { error: 'expected a sha256 (64 lower-case hex digits)' });
const commitText = z
  .string({ error: 'expected a commit' })
  .regex(/^[0-9a-f]{40}$/, { error: 'expected a full commit hash (40 lower-case hex digits)' });
// a version, or (pinned) { version, commit } / { version, sha256 }
const lockedEntry = z.union(
  [
    text,
    z.strictObject({ version: text, commit: commitText.optional(), sha256: sha256Text.optional() }),
  ],
  {
    error:
      'expected a version, or { version: <version>, commit: <commit> } or { version: <version>, sha256: <sha256> }',
  },
);
const versionOf = (e: z.output<typeof lockedEntry>) => (typeof e === 'string' ? e : e.version);
const pinOf = (e: z.output<typeof lockedEntry>): SourcePin | undefined =>
  typeof e === 'string' || (!e.commit && !e.sha256)
    ? undefined
    : { ...(e.commit ? { commit: e.commit } : {}), ...(e.sha256 ? { sha256: e.sha256 } : {}) };

const folderLockSchema = z
  .strictObject({
    engine: text,
    ffmpeg: z.record(text, lockedEntry).default({}),
    libraries: z.record(name, lockedEntry).default({}),
  })
  .superRefine((raw, ctx) => {
    // one version is one content: a version pinned twice, differently, can't both be right
    const key = (p: SourcePin) => `${p.commit ?? ''}/${p.sha256 ?? ''}`;
    const bySeries = new Map<string, { series: string; pin: SourcePin }[]>();
    for (const [series, e] of Object.entries(raw.ffmpeg)) {
      const pin = pinOf(e);
      if (pin?.commit && pin.sha256) {
        ctx.addIssue({
          code: 'custom',
          path: ['ffmpeg', series],
          message: `FFmpeg ${versionOf(e)} has two different pins (a commit and a sha256): its source is one or the other`,
        });
      }
      if (pin) {
        bySeries.set(versionOf(e), [...(bySeries.get(versionOf(e)) ?? []), { series, pin }]);
      }
    }
    for (const [version, pins] of bySeries) {
      if (new Set(pins.map((p) => key(p.pin))).size > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['ffmpeg'],
          message: `FFmpeg ${version} has two different pins (series ${pins.map((p) => JSON.stringify(p.series)).join(', ')}): one release is one tarball`,
        });
      }
    }
    for (const [library, e] of Object.entries(raw.libraries)) {
      const pin = pinOf(e);
      if (pin?.commit && pin.sha256) {
        ctx.addIssue({
          code: 'custom',
          path: ['libraries', library],
          message: `${library} ${versionOf(e)} has two different pins (a commit and a sha256): its source is one or the other`,
        });
      }
    }
  })
  .transform((raw): FolderLock => {
    const split = (o: Record<string, z.output<typeof lockedEntry>>) => ({
      versions: Object.fromEntries(Object.entries(o).map(([k, e]) => [k, versionOf(e)])),
      pins: Object.fromEntries(
        Object.entries(o).flatMap(([k, e]) => (pinOf(e) ? [[k, pinOf(e)!]] : [])),
      ),
    });
    const ffmpeg = split(raw.ffmpeg);
    const libraries = split(raw.libraries);
    const pinned = Object.keys(ffmpeg.pins).length + Object.keys(libraries.pins).length > 0;
    return {
      engine: raw.engine,
      ffmpeg: ffmpeg.versions,
      libraries: libraries.versions,
      ...(pinned ? { pins: { ffmpeg: ffmpeg.pins, libraries: libraries.pins } } : {}),
    };
  });

export function parseFolderLock(source: string, file: string): FolderLock {
  let raw: unknown;
  try {
    raw = parseYaml(source, file);
  } catch (e) {
    if (e instanceof YamlError) {
      throw new LockError(`${e.message} (${RECOVER})`);
    }
    throw e;
  }
  if (raw && typeof raw === 'object' && 'profiles' in raw) {
    throw new LockError(
      `${file} predates targets (it has profiles:); run \`ffmpeg-build migrate\` to convert this folder`,
    );
  }
  const parsed = folderLockSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new LockError(
      `${formatIssues(parsed.error)
        .map((m) => `${file}: ${m}`)
        .join('\n')}\n(${RECOVER})`,
    );
  }
  return parsed.data;
}

/** The folder lock at `path`, or undefined when there is none yet. */
export function readFolderLock(path: string): FolderLock | undefined {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw e;
  }
  return parseFolderLock(source, displayPath(path));
}

/** A version, with its pin when it has one: `1.5.4`, or `{ version: 1.5.4, commit: <commit> }`. */
function entryText(version: string, pin: SourcePin | undefined): string {
  if (!pin?.commit && !pin?.sha256) {
    return plain(version);
  }
  return `{ version: ${plain(version)}${pin.commit ? `, commit: ${pin.commit}` : ''}${pin.sha256 ? `, sha256: ${pin.sha256}` : ''} }`;
}

/** Fixed layout: series and libraries sorted, so diffs show only real changes. */
export function formatFolderLock(lock: FolderLock): string {
  const series = Object.keys(lock.ffmpeg).sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );
  const out = [HEADER, `engine: ${plain(lock.engine)}`];
  // a lock without pins keeps its one-line ffmpeg: map; pinned, each series gets a line of its own
  if (series.some((s) => lock.pins?.ffmpeg[s])) {
    out.push('ffmpeg:');
    for (const s of series) {
      out.push(`  ${JSON.stringify(s)}: ${entryText(lock.ffmpeg[s]!, lock.pins?.ffmpeg[s])}`);
    }
  } else {
    out.push(
      `ffmpeg: { ${series.map((s) => `${JSON.stringify(s)}: ${plain(lock.ffmpeg[s]!)}`).join(', ')} }`,
    );
  }
  const libraries = Object.keys(lock.libraries).sort();
  out.push(libraries.length ? 'libraries:' : 'libraries: {}');
  for (const l of libraries) {
    out.push(`  ${l}: ${entryText(lock.libraries[l]!, lock.pins?.libraries[l])}`);
  }
  return `${out.join('\n')}\n`;
}
