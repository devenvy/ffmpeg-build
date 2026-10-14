// Unpacks a .tar.gz safely, without a system tar (whose flavour and path handling differ per OS). Every entry must stay
// inside the destination: names are checked as text, nothing is ever written through a link, and a symlink must be
// relative and resolve inside, walking through no other link (checkLinkTarget), so no chain of links can lead out.
// Handles ustar, GNU long names and pax records.
// The archive is streamed from its file, never held in memory, within limits on what it unpacks to: the total size, any
// one file's size, and the number of entries (a gzip bomb is refused as soon as a header claims too much).
import {
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, posix, relative, sep, win32 } from 'node:path';
import { createGunzip, gunzipSync } from 'node:zlib';

import { anyExecBit } from './tar-write.ts';

export class UnsafeArchiveError extends Error {}

interface Entry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'hardlink';
  data: Buffer;
  mode: number;
  link: string;
}

export interface UnpackLimits {
  /** The most it may unpack to, in all (default 4 GB: FFmpeg's biggest archive is a few hundred MB). */
  maxTotal?: number;
  /** The largest one file may be (default 2 GB). */
  maxFile?: number;
  /** The most entries it may hold (default 200 000). */
  maxEntries?: number;
}

const MIB = 1_048_576;
const DEFAULT_LIMITS: Required<UnpackLimits> = {
  maxTotal: 4_294_967_296, // 4 GiB
  maxFile: 2_147_483_648, // 2 GiB
  maxEntries: 200_000,
};
/** A long name, long link or pax record is held in memory: never more than this. */
const MAX_META = MIB;

/** A tar block: headers are one, and every entry's data is padded to a whole number of them. */
const BLOCK = 512;
/** Where each ustar header field is: from `start` up to `end`. */
const FIELD = {
  name: { start: 0, end: 100 },
  mode: { start: 100, end: 108 },
  size: { start: 124, end: 136 },
  link: { start: 157, end: 257 },
  prefix: { start: 345, end: 500 },
} as const;
/** The type flag's offset in a header. */
const TYPE_AT = 156;
/** A base-256 number (GNU) sets the top bit of its first byte; the rest of that byte is its highest digit. */
const BASE256_FLAG = 0x80;
const BYTE_VALUES = 256;
const OCTAL = 8;
/** What an extracted file with any execute bit gets. */
const MODE_EXECUTABLE = 0o755;

const field = (h: Buffer, f: { start: number; end: number }) => h.subarray(f.start, f.end);
const text = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');
/** A tar number: octal text, or base-256 when the top bit of the first byte is set (GNU, for sizes over 8 GB). */
function num(b: Buffer): number {
  if (b[0]! >= BASE256_FLAG) {
    return b.subarray(1).reduce((n, byte) => n * BYTE_VALUES + byte, b[0]! - BASE256_FLAG);
  }
  return parseInt(text(b).trim() || '0', OCTAL);
}
/** An entry's name: a pax path, else a GNU long name, else the header's prefix and name. */
function entryName(h: Buffer, pax: Record<string, string>, longName: string | undefined): string {
  const prefix = text(field(h, FIELD.prefix));
  const short = text(field(h, FIELD.name));
  return pax['path'] ?? longName ?? (prefix ? `${prefix}/${short}` : short);
}
/** The bytes that pad `size` bytes of data to a whole block. */
const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

type Flag = 'file' | 'dir' | 'symlink' | 'hardlink';
const TYPES: Record<string, Flag> = {
  '5': 'dir',
  '2': 'symlink',
  '1': 'hardlink',
  '0': 'file',
  '\0': 'file',
  '7': 'file',
};
const typeOf = (flag: string): Flag | undefined =>
  Object.hasOwn(TYPES, flag) ? TYPES[flag] : undefined;

/** Ends what nobody will read, or a sink with nothing to undo; a failure to do so changes nothing. */
const ignore = (): void => undefined;

/** The archive's entries, in order, read from memory (for tests and small archives). */
export function readTarGz(gz: Buffer): Entry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: DEFAULT_LIMITS.maxTotal });
  } catch (e) {
    throw new UnsafeArchiveError(`not a readable .tar.gz (${(e as Error).message})`);
  }
  const entries: Entry[] = [];
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  for (let at = 0; at + BLOCK <= tar.length;) {
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) {
      break;
    }
    const size = pax['size'] ? Number(pax['size']) : num(field(h, FIELD.size));
    const flag = String.fromCharCode(h[TYPE_AT]!);
    if (at + BLOCK + size > tar.length) {
      throw new UnsafeArchiveError('the archive is cut short');
    }
    const data = tar.subarray(at + BLOCK, at + BLOCK + size);
    at += BLOCK + size + padding(size);
    if (flag === 'L') {
      longName = text(data);
    } else if (flag === 'K') {
      longLink = text(data);
    } else if (flag === 'x') {
      pax = parsePax(data);
    } else if (flag !== 'g') {
      const name = entryName(h, pax, longName);
      const link = pax['linkpath'] ?? longLink ?? text(field(h, FIELD.link));
      longName = undefined;
      longLink = undefined;
      pax = {};
      const type = typeOf(flag);
      if (!type) {
        throw new UnsafeArchiveError(`unsupported entry ${name} (type ${flag})`);
      }
      entries.push({ name, type, data: Buffer.from(data), mode: num(field(h, FIELD.mode)), link });
    }
  }
  return entries;
}

function parsePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(' ', at);
    const len = parseInt(data.subarray(at, space).toString('utf8'), 10);
    if (!len) {
      break;
    }
    const record = data.subarray(space + 1, at + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

/** Where `name` lands under `dest` (undefined for the folder itself), or an error when it would land outside. */
function inside(dest: string, name: string): string | undefined {
  if (name.includes('\\')) {
    throw new UnsafeArchiveError(`${name}: a backslash in a name`);
  }
  const clean = name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (clean === '' || clean === '.') {
    return undefined;
  }
  if (isAbsolute(clean) || /^[A-Za-z]:/.test(clean)) {
    throw new UnsafeArchiveError(`${name}: an absolute path`);
  }
  if (clean.split('/').includes('..')) {
    throw new UnsafeArchiveError(`${name}: a .. in its path`);
  }
  const path = normalize(join(dest, clean));
  const rel = relative(dest, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new UnsafeArchiveError(`${name}: outside the archive's folder`);
  }
  return path;
}

/**
 * Refuses a symlink target that could lead outside the destination: empty, absolute (POSIX or Windows),
 * drive-prefixed (`C:x` is relative to C:'s current folder, `C:/x` absolute), UNC (`//host` or `\\host`), with a
 * backslash, or resolving (from the link's own folder, `..` included) outside the destination. A relative link that
 * stays inside is fine, `..` and all: libraries install `bin/z -> ../lib/libz.so.1`.
 *
 * Resolving by text matches what the OS does only when no folder the target walks through is itself a link (`a/l ->
 * ..` makes `a/l/../x` mean `<dest>/../x`), so `linkAt(path)` (a path relative to the destination, `/`-separated)
 * says which are links, in the archive or already on disk, and a target through one is refused.
 * Shared by the extractor and the cache-member check, so the two can't drift.
 */
function checkLinkTarget(
  name: string,
  link: string,
  linkAt: (path: string) => boolean = () => false,
): void {
  const refuse = (why: string): never => {
    throw new UnsafeArchiveError(
      `${name}: a link that leaves its folder (${link || '(empty)'}: ${why})`,
    );
  };
  if (!link) {
    refuse('empty');
  }
  if (link.includes('\\')) {
    refuse('a backslash');
  }
  if (/^[A-Za-z]:/.test(link)) {
    refuse('a drive');
  }
  if (link.startsWith('/') || posix.isAbsolute(link) || win32.isAbsolute(link)) {
    refuse('absolute');
  }
  // walk it from the link's folder, one name at a time
  const at = name
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .slice(0, -1)
    .filter((p) => p && p !== '.');
  const parts = link.split('/');
  parts.forEach((part, i) => {
    if (part === '' || part === '.') {
      return;
    }
    if (part === '..') {
      if (!at.length) {
        refuse('outside the destination');
      }
      at.pop();
      return;
    }
    at.push(part);
    // a folder walked through (not the last name, which is what the link names) must not be a link
    if (i < parts.length - 1 && linkAt(at.join('/'))) {
      refuse(`goes through a link (${at.join('/')})`);
    }
  });
}

/** Refuses a path any of whose folders under `dest` is a link: nothing is ever written through one. */
function noLinkOnTheWay(dest: string, path: string, name: string): void {
  for (let d = dirname(path); d.length > dest.length; d = dirname(d)) {
    // a folder not made yet is no link
    if (isLink(d)) {
      throw new UnsafeArchiveError(`${name}: goes through a link`);
    }
  }
}

/** Reads a stream in exact amounts: a header, a record, or a file's data passed on chunk by chunk. */
interface Reader {
  /** Exactly `n` bytes, or fewer at the end of the stream. */
  take: (n: number) => Promise<Buffer>;
  /** Passes on exactly `n` bytes; false when the stream ended first. */
  pass: (n: number, to: (chunk: Buffer) => void) => Promise<boolean>;
  close: () => Promise<void>;
}

function reader(stream: AsyncIterable<Buffer>): Reader {
  const it = stream[Symbol.asyncIterator]();
  let pending: Buffer = Buffer.alloc(0);
  let ended = false;
  /** Records that the stream has ended: `more` reads nothing after that. */
  const end = (): false => {
    ended = true;
    return false;
  };
  const more = async (): Promise<boolean> => {
    if (ended) {
      return false;
    }
    const r = await it.next();
    if (r.done) {
      return end();
    }
    pending = pending.length ? Buffer.concat([pending, r.value]) : r.value;
    return true;
  };
  return {
    async take(n) {
      while (pending.length < n) {
        if (!(await more())) {
          break;
        }
      }
      const out = pending.subarray(0, n);
      pending = pending.subarray(out.length);
      return out;
    },
    async pass(n, to) {
      let left = n;
      while (left > 0) {
        if (!pending.length && !(await more())) {
          return false;
        }
        const chunk = pending.subarray(0, left);
        pending = pending.subarray(chunk.length);
        left -= chunk.length;
        to(chunk);
      }
      return true;
    },
    async close() {
      await it.return?.();
    },
  };
}

/**
 * Unpacks the .tar.gz at `archive` into `dest` (created), streaming it. Links are made last, after every file; a
 * symlink must pass checkLinkTarget (relative, resolving inside, through no other link), a hard link must name a file
 * of the archive. Where the OS refuses a
 * symlink, the file is copied instead. UnsafeArchiveError when an entry would leave `dest`, the archive is cut short
 * or unreadable, or it goes past `limits`.
 */
export async function extractTarGzFile(
  archive: string,
  dest: string,
  limits: UnpackLimits = {},
): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const links: { path: string; name: string; target: string; hard: boolean }[] = [];
  await walkTarGzFile(
    archive,
    (e) => {
      const path = inside(dest, e.name);
      if (!path) {
        if (e.type !== 'dir') {
          throw new UnsafeArchiveError(`${e.name || '(empty name)'}: not a file name`);
        }
        return undefined;
      }
      noLinkOnTheWay(dest, path, e.name);
      if (e.type === 'dir') {
        mkdirSync(path, { recursive: true });
      } else if (e.type === 'symlink') {
        checkLinkTarget(e.name, e.link); // early; again in makeLinks, knowing every link of the archive
        links.push({ path, name: e.name, target: e.link, hard: false });
      } else if (e.type === 'hardlink') {
        links.push({ path, name: e.name, target: inside(dest, e.link) ?? dest, hard: true });
      } else {
        mkdirSync(dirname(path), { recursive: true });
        const fd = openSync(path, 'w');
        return {
          write: (chunk) => {
            writeSync(fd, chunk);
          },
          end: () => {
            closeSync(fd);
            if (anyExecBit(e.mode)) {
              chmodSync(path, MODE_EXECUTABLE);
            }
          },
          abort: () => {
            closeSync(fd);
          },
        };
      }
      return undefined;
    },
    limits,
  );
  makeLinks(dest, links);
}

/** An entry's header, as walkTarGzFile passes it on. */
interface TarEntry {
  name: string;
  type: Flag;
  size: number;
  mode: number;
  link: string;
}
/** Where an entry's data goes (a file's), or 'stop' to read no further. */
interface Sink {
  write: (chunk: Buffer) => void;
  end: () => void;
  abort: () => void;
}

/**
 * Streams the .tar.gz at `archive`, handing each entry's header to `visit`, which returns where its data goes (or
 * nothing, to skip it; or 'stop'). Long names and pax records are applied; `limits` are enforced as headers come.
 */
async function walkTarGzFile(
  archive: string,
  visit: (e: TarEntry) => Sink | 'stop' | undefined,
  limits: UnpackLimits = {},
): Promise<void> {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const gunzip = createGunzip();
  const source = createReadStream(archive);
  const unzipped = source.pipe(gunzip);
  source.on('error', (e) => {
    gunzip.destroy(e);
  });
  const read = reader(unzipped);
  let total = 0;
  let count = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  const cutShort = () => new UnsafeArchiveError('the archive is cut short');
  const skipPadding = async (size: number) => {
    const pad = padding(size);
    if (pad && (await read.take(pad)).length < pad) {
      throw cutShort();
    }
  };
  const meta = async (size: number): Promise<Buffer> => {
    if (size > MAX_META) {
      throw new UnsafeArchiveError(`a name or pax record of ${String(size)} bytes`);
    }
    const data = await read.take(size);
    if (data.length < size) {
      throw cutShort();
    }
    await skipPadding(size);
    return data;
  };
  /** Reads a long name, long link or pax record (they apply to the next entry); false when the entry is none of them. */
  const applyMeta = async (flag: string, size: number): Promise<boolean> => {
    if (flag === 'L') {
      longName = text(await meta(size));
    } else if (flag === 'K') {
      longLink = text(await meta(size));
    } else if (flag === 'x') {
      pax = parsePax(await meta(size));
    } else if (flag === 'g') {
      await meta(size);
    } else {
      return false;
    }
    return true;
  };
  /** Checks an entry against the limits, hands it to `visit` and passes its data on; 'stop' when `visit` says so. */
  const entry = async (h: Buffer, size: number, flag: string): Promise<'stop' | undefined> => {
    const name = entryName(h, pax, longName);
    const link = pax['linkpath'] ?? longLink ?? text(field(h, FIELD.link));
    const mode = num(field(h, FIELD.mode));
    longName = undefined;
    longLink = undefined;
    pax = {};
    const type = typeOf(flag);
    if (!type) {
      throw new UnsafeArchiveError(`unsupported entry ${name} (type ${flag})`);
    }
    if (++count > lim.maxEntries) {
      throw new UnsafeArchiveError(`more than ${String(lim.maxEntries)} entries`);
    }
    const dataSize = type === 'file' ? size : 0;
    if (dataSize > lim.maxFile) {
      throw new UnsafeArchiveError(`${name}: larger than ${String(lim.maxFile)} bytes`);
    }
    total += dataSize;
    if (total > lim.maxTotal) {
      throw new UnsafeArchiveError(`more than ${String(lim.maxTotal)} bytes unpacked`);
    }
    const sink = visit({ name, type, size, mode, link });
    if (sink === 'stop') {
      return 'stop';
    }
    if (sink && type === 'file') {
      let ok: boolean;
      try {
        ok = await read.pass(size, (chunk) => {
          sink.write(chunk);
        });
      } catch (e) {
        sink.abort();
        throw e;
      }
      if (!ok) {
        sink.abort();
        throw cutShort();
      }
      sink.end();
    } else if (size && !(await read.pass(size, ignore))) {
      throw cutShort();
    } // skipped, or a link with a size
    if (size) {
      await skipPadding(size);
    }
    return undefined;
  };
  try {
    for (;;) {
      const h = await read.take(BLOCK);
      if (h.length === 0) {
        break;
      } // no end marker: tolerated, as tar does
      if (h.length < BLOCK) {
        throw cutShort();
      }
      if (h.every((b) => b === 0)) {
        break;
      }
      const size = pax['size'] ? Number(pax['size']) : num(field(h, FIELD.size));
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new UnsafeArchiveError('an entry with an impossible size');
      }
      const flag = String.fromCharCode(h[TYPE_AT]!);
      const isMeta = await applyMeta(flag, size);
      if (!isMeta && (await entry(h, size, flag)) === 'stop') {
        break;
      }
    }
  } catch (e) {
    if (e instanceof UnsafeArchiveError) {
      throw e;
    }
    throw new UnsafeArchiveError(`not a readable .tar.gz (${(e as Error).message})`);
  } finally {
    await read.close().catch(ignore);
    source.destroy();
  }
}

/** One member of a .tar.gz (the first whose name `match`es), read into memory up to `maxSize`; undefined when absent. */
export async function readTarGzMember(
  archive: string,
  match: (name: string) => boolean,
  maxSize = MIB,
): Promise<{ name: string; data: Buffer } | undefined> {
  let found: { name: string; data: Buffer } | undefined;
  await walkTarGzFile(archive, (e) => {
    if (found) {
      return 'stop';
    }
    if (e.type !== 'file' || !match(e.name.replace(/^(\.\/)+/, ''))) {
      return undefined;
    }
    if (e.size > maxSize) {
      throw new UnsafeArchiveError(`${e.name}: larger than ${String(maxSize)} bytes`);
    }
    const parts: Buffer[] = [];
    return {
      write: (chunk) => {
        parts.push(Buffer.from(chunk));
      },
      end: () => {
        found = { name: e.name.replace(/^(\.\/)+/, ''), data: Buffer.concat(parts) };
      },
      abort: ignore,
    };
  });
  return found;
}

/** Whether `path` is a regular file (not a link to one); false when it can't be read. */
function isPlainFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** A symlink as the archive has it; where the OS refuses one, a copy of the file it names. */
function makeSymlink(l: { path: string; target: string }): void {
  try {
    symlinkSync(l.target, l.path);
  } catch {
    // Windows without symlink rights: copy the file it names, when that is a plain file of the archive
    const resolved = join(dirname(l.path), l.target);
    try {
      if (lstatSync(resolved).isFile()) {
        copyFileSync(resolved, l.path);
      }
    } catch {
      // a dangling link: nothing to copy
    }
  }
}

/** Makes the links extractTarGzFile collected, after every file. */
function makeLinks(
  dest: string,
  links: { path: string; name: string; target: string; hard: boolean }[],
): void {
  const symlinks = new Set(
    links.filter((l) => !l.hard).map((l) => l.name.replace(/^(\.\/)+/, '').replace(/\/+$/, '')),
  );
  const linkAt = (p: string) => symlinks.has(p) || isLink(join(dest, ...p.split('/')));
  // every target, before any link is made: none may walk through another link
  for (const l of links) {
    if (!l.hard) {
      checkLinkTarget(l.name, l.target, linkAt);
    }
  }
  for (const l of links) {
    mkdirSync(dirname(l.path), { recursive: true });
    noLinkOnTheWay(dest, l.path, l.name);
    if (l.hard) {
      // a hard link becomes a copy of a regular file the archive already wrote, reached without passing a link
      noLinkOnTheWay(dest, l.target, l.name);
      if (!isPlainFile(l.target)) {
        throw new UnsafeArchiveError(
          `${l.name}: a hard link to something that isn't a file of the archive`,
        );
      }
      copyFileSync(l.target, l.path);
    } else {
      makeSymlink(l);
    }
  }
}

/**
 * Moves everything in `from` into `into` (both unpacked by extractTarGzFile), refusing any path that would pass
 * through a link of `into`; a file already in `into` is kept.
 */
export function mergeInto(from: string, into: string): void {
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const src = join(dir, e.name);
      const dst = join(into, relative(from, src));
      noLinkOnTheWay(into, dst, relative(from, src));
      if (e.isDirectory() && !e.isSymbolicLink()) {
        mkdirSync(dst, { recursive: true });
        walk(src);
      } else if (!existsSync(dst) && !isLink(dst)) {
        renameSync(src, dst);
      }
    }
  };
  walk(from);
}

/** A member as a listing gives it: its name, its type and, for a link, what it points at. */
export interface TarMember {
  name: string;
  type: Entry['type'];
  link: string;
}

/**
 * The members of a .tar.gz, read as a stream (headers only: file contents are skipped, so a big archive costs no
 * memory). Handles ustar, GNU long names and pax records, as walkTarGzFile does; sizes are not limited, as nothing
 * is unpacked.
 */
export async function listTarGzMembers(path: string): Promise<TarMember[]> {
  const members: TarMember[] = [];
  await walkTarGzFile(
    path,
    (e) => {
      members.push({
        name: e.name,
        type: e.type,
        link: e.type === 'symlink' || e.type === 'hardlink' ? e.link : '',
      });
      return undefined;
    },
    {
      maxTotal: Number.POSITIVE_INFINITY,
      maxFile: Number.POSITIVE_INFINITY,
      maxEntries: Number.POSITIVE_INFINITY,
    },
  );
  return members;
}

/**
 * Refuses members a system tar would put outside `dest` or write through a link: an absolute path or a `..` in a
 * name, a symlink checkLinkTarget refuses, a hard link to a name that
 * is absolute or has a `..`, and any member under a folder that is a symlink, in the archive or already on disk.
 */
export function checkTarMembers(
  members: readonly TarMember[],
  dest: string,
  isLinkOnDisk: (path: string) => boolean = isLink,
): void {
  const linksInArchive = new Set<string>();
  const clean = (name: string) => name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  // a link target may not walk through any symlink of the archive, wherever it comes in it
  const allSymlinks = new Set(
    members.filter((m) => m.type === 'symlink').map((m) => clean(m.name)),
  );
  const linkAt = (p: string) => allSymlinks.has(p) || isLinkOnDisk(join(dest, ...p.split('/')));
  for (const m of members) {
    const name = clean(m.name);
    if (name === '' || name === '.') {
      // the folder itself is fine as a folder; anything else by that name has no file name
      if (m.type !== 'dir') {
        throw new UnsafeArchiveError(`${m.name || '(empty name)'}: not a file name`);
      }
    } else {
      inside(dest, m.name);
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i++) {
        const folder = parts.slice(0, i).join('/');
        if (linksInArchive.has(folder) || isLinkOnDisk(join(dest, ...parts.slice(0, i)))) {
          throw new UnsafeArchiveError(`${m.name}: goes through a link`);
        }
      }
      if (m.type === 'symlink') {
        checkLinkTarget(m.name, m.link, linkAt);
        linksInArchive.add(name);
      }
      if (m.type === 'hardlink') {
        inside(dest, m.link);
      }
    }
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
