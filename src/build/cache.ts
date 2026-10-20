import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

import { checkTarMembers, listTarGzMembers, UnsafeArchiveError } from '../untar.ts';
import { keptFiles, sha256, type SourceRecord } from './fetch.ts';
import { run } from './run.ts';

import type { LicenseFile } from '../schema/engine.ts';

export const FFB_SHARE = 'share/ffmpeg-build';

/** A file mode's permission bits (setuid, setgid, sticky and rwx) are its value below this: mode % 0o10000. */
const PERMISSIONS_SPAN = 0o10000;

function entries(root: string, dir = root): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() && !entry.isSymbolicLink()
      ? entries(root, path)
      : [relative(root, path).replaceAll('\\', '/')];
  });
}

/** File facts used to find everything a recipe installed or replaced. */
export function listing(root: string): Map<string, string> {
  return new Map(
    entries(root)
      .sort()
      .map((path) => {
        const full = join(root, path);
        const stat = lstatSync(full);
        return [
          path,
          `${stat.size}\t${stat.mtimeMs}\t${String(stat.mode % PERMISSIONS_SPAN)}\t${stat.isSymbolicLink() ? readlinkSync(full) : ''}`,
        ];
      }),
  );
}

export function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...after].filter(([path, fact]) => before.get(path) !== fact).map(([path]) => path);
}

/** Where a kept source is: `file` (as a source record names it) under `sources`, never anywhere else. */
export function keptPath(sources: string, file: string): string {
  const root = resolve(sources);
  const path = resolve(root, file);
  const rel = relative(root, path);
  if (
    !file ||
    isAbsolute(file) ||
    /^[A-Za-z]:/.test(file) ||
    !rel ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error(`${file || '(no file)'} is outside the cache's sources folder`);
  }
  return path;
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const crateSchema = z.union([
  z.strictObject({
    name: z.string().min(1),
    version: z.string().min(1),
    license: z.string().min(1).optional(),
    source: z.literal('crates.io'),
    file: z.string().min(1),
    sha256: sha256Schema,
    linked: z.boolean(),
    texts: z.array(z.string().min(1)),
    standard: z.array(z.string().min(1)).optional(),
    authors: z.array(z.string()).optional(),
  }),
  z.strictObject({
    name: z.string().min(1),
    version: z.string().min(1),
    license: z.string().min(1).optional(),
    source: z.literal('path'),
    linked: z.boolean(),
    texts: z.array(z.string().min(1)),
    standard: z.array(z.string().min(1)).optional(),
    authors: z.array(z.string()).optional(),
  }),
]);
const recordSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().min(1),
  origin: z.string().min(1),
  file: z.string().min(1),
  sha256: sha256Schema,
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  cached: z.boolean().optional(),
  crates: z.array(crateSchema).optional(),
  rust: z
    .strictObject({ version: z.string().min(1), texts: z.array(z.string().min(1)) })
    .optional(),
});

/**
 * A cache entry's source record, when it is one this build can trust: for library `name`, with a sha256 and (for a
 * git source) a full commit, naming a kept source inside `sources`. Anything else is undefined: the entry is rebuilt.
 */
export function parseSourceRecord(
  raw: unknown,
  name: string,
  sources: string,
): SourceRecord | undefined {
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success || parsed.data.name !== name) {
    return undefined;
  }
  try {
    for (const kept of keptFiles(parsed.data)) {
      keptPath(sources, kept.file);
    }
  } catch {
    return undefined;
  }
  const record: SourceRecord = { ...parsed.data };
  delete record.cached;
  return record;
}

/** Deletes an unusable cache entry: the entry itself, never a path its contents name. */
function discard(cached: string, name: string, why: string): undefined {
  process.stdout.write(`  ${name}: the cache entry ${cached} ${why}; building it again\n`);
  rmSync(cached, { force: true });
  return undefined;
}

/**
 * Unpacks a library's cache entry into `depsDir` when it can be trusted: its source record checks out (see
 * parseSourceRecord), the kept source it names is on file with that sha256, and every member stays inside `depsDir`
 * (no absolute path, no `..`, no link out of it, nothing written through a link), and it was built from the content
 * ffmpeg.lock pins (`pin`), when it pins any. An entry that fails is deleted and the library built again.
 */
export async function restoreCache(
  cached: string,
  depsDir: string,
  sources: string,
  name: string,
  runner: typeof run = run,
  pin: { sha256?: string | undefined; commit?: string | undefined } = {},
  expect: { crates?: boolean } = {},
): Promise<SourceRecord | undefined> {
  if (!existsSync(cached)) {
    return undefined;
  }
  const recordPath = `${FFB_SHARE}/sources/${name}.json`;
  let raw: unknown;
  try {
    raw = JSON.parse(await runner('tar', ['-xzf', cached, '-O', recordPath], { capture: true }));
  } catch {
    return discard(cached, name, 'has no readable source record');
  }
  const record = parseSourceRecord(raw, name, sources);
  if (!record) {
    return discard(cached, name, `has a source record that isn't valid for ${name}`);
  }
  if (pin.commit && record.commit !== pin.commit) {
    return discard(
      cached,
      name,
      `was built from commit ${record.commit ?? '(none)'}, not the ${pin.commit} ffmpeg.lock pins`,
    );
  }
  if (pin.sha256 && record.sha256 !== pin.sha256) {
    return discard(
      cached,
      name,
      `was built from a source with sha256 ${record.sha256}, not the ${pin.sha256} ffmpeg.lock pins`,
    );
  }
  if (expect.crates && !record.crates) {
    return discard(cached, name, 'lists no Rust crates (an older engine built it)');
  }
  for (const { file, sha256: recorded } of keptFiles(record)) {
    const kept = keptPath(sources, file);
    if (!existsSync(kept) || sha256(kept) !== recorded) {
      return discard(
        cached,
        name,
        `names a source that isn't on file under sources/ as recorded (${file})`,
      );
    }
  }
  try {
    checkTarMembers(await listTarGzMembers(cached), depsDir);
  } catch (error) {
    if (error instanceof UnsafeArchiveError) {
      return discard(cached, name, `is unsafe to unpack (${error.message})`);
    }
    throw error;
  }
  try {
    await runner('tar', ['-xzf', cached, '-C', depsDir]);
  } catch (error) {
    // part of it may be unpacked already: building on top of that could mix two builds, so stop
    throw new Error(
      `the cache entry ${cached} for ${name} can't be unpacked (${error instanceof Error ? error.message : String(error)}); \`ffmpeg-build cache verify --fix\` removes it (or delete it), then build again`,
      { cause: error },
    );
  }
  return { ...record, cached: true };
}

export function copyLicenses(
  name: string,
  version: string,
  src: string,
  recipeDir: string,
  depsDir: string,
  files: readonly LicenseFile[],
): void {
  const dest = join(depsDir, FFB_SHARE, 'legal', name);
  rmSync(dest, { recursive: true, force: true });
  const missing: string[] = [];
  for (const file of files) {
    const from = join(file.recipe ? recipeDir : src, file.path);
    if (existsSync(from)) {
      const to = join(dest, file.path);
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    } else {
      missing.push(file.path);
    }
  }
  if (missing.length) {
    throw new Error(
      `${name} ${version} has no ${missing.join(' ')}, which recipes/${name}/recipe.yml lists in license-files`,
    );
  }
}

export function writeSourceRecord(depsDir: string, record: SourceRecord): void {
  const path = join(depsDir, FFB_SHARE, 'sources', `${record.name}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`);
}

export async function saveCache(
  cached: string,
  depsDir: string,
  files: readonly string[],
  work: string,
): Promise<void> {
  mkdirSync(dirname(cached), { recursive: true });
  const list = join(work, `cache-files-${process.pid}`);
  writeFileSync(list, `${files.join('\n')}\n`);
  const temp = `${cached}.tmp.${process.pid}.${Date.now()}`;
  try {
    await run('tar', ['-czf', temp, '-C', depsDir, '--verbatim-files-from', '-T', list]);
    renameSync(temp, cached);
  } finally {
    rmSync(temp, { force: true });
    rmSync(list, { force: true });
  }
}
