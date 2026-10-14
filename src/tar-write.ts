// Writes a .tar.gz without a system tar: ustar headers, a pax record for a path longer than ustar holds, files
// streamed through gzip. Entries are written in the order given, with a fixed mtime, so the same input gives the same
// archive.
import { createWriteStream, readFileSync, statSync } from 'node:fs';
import { createGzip } from 'node:zlib';

export type TarEntry = { path: string; file: string } | { path: string; text: string };

const MTIME = 0o14000000000; // 2014-12-03, any fixed date: the archive doesn't depend on when it was made

/** A tar block: headers are one, and every file's data is padded to a whole number of them. */
const BLOCK = 512;
/** Where each ustar header field starts, and the widths of the ones written with padding. */
const FIELD = {
  name: 0,
  mode: 100,
  uid: 108,
  gid: 116,
  size: 124,
  mtime: 136,
  checksum: 148,
  type: 156,
  magic: 257,
  version: 263,
} as const;
const NAME_LENGTH = 100;
const MODE_DIGITS = 7;
const NUMBER_DIGITS = 11;
const CHECKSUM_DIGITS = 6;
const OCTAL = 8;
/** The archive ends with two zero blocks. */
const END_OF_ARCHIVE = 1024;
/** The modes written: executable or not, nothing else is kept. */
const MODE_EXECUTABLE = 0o755;
const MODE_FILE = 0o644;
/** The owner, group and other execute bits. */
const EXEC_OWNER = 0o100;
const EXEC_GROUP = 0o010;
const EXEC_OTHER = 0o001;
const GZIP_LEVEL = 9;

/** Whether `bit` (a power of two) is set in `mode`: its place and those below it hold at least `bit`. */
const hasBit = (mode: number, bit: number) => mode % (bit + bit) >= bit;

/** Whether any execute bit (owner, group or other) is set in a file mode. */
export const anyExecBit = (mode: number): boolean =>
  hasBit(mode, EXEC_OWNER) || hasBit(mode, EXEC_GROUP) || hasBit(mode, EXEC_OTHER);

function header(name: string, size: number, mode: number, type: '0' | 'x'): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name.slice(0, NAME_LENGTH), FIELD.name, NAME_LENGTH);
  h.write(`${mode.toString(OCTAL).padStart(MODE_DIGITS, '0')}\0`, FIELD.mode);
  h.write('0000000\0', FIELD.uid);
  h.write('0000000\0', FIELD.gid);
  h.write(`${size.toString(OCTAL).padStart(NUMBER_DIGITS, '0')}\0`, FIELD.size);
  h.write(`${MTIME.toString(OCTAL).padStart(NUMBER_DIGITS, '0')}\0`, FIELD.mtime);
  h.write('        ', FIELD.checksum);
  h.write(type, FIELD.type);
  h.write('ustar\0', FIELD.magic);
  h.write('00', FIELD.version);
  let sum = 0;
  for (const b of h) {
    sum += b;
  }
  h.write(`${sum.toString(OCTAL).padStart(CHECKSUM_DIGITS, '0')}\0 `, FIELD.checksum);
  return h;
}

const pad = (n: number) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);

/** A pax record "<len> path=<value>\n", where <len> counts itself. */
function paxPath(path: string): Buffer {
  const body = ` path=${path}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${len}${body}`) !== len) {
    len = Buffer.byteLength(`${len}${body}`);
  }
  return Buffer.from(`${len}${body}`);
}

/** Writes `entries` (regular files) to `out` as a gzipped tar. */
export async function writeTarGz(out: string, entries: TarEntry[]): Promise<void> {
  const gz = createGzip({ level: GZIP_LEVEL });
  const done = new Promise<void>((resolve, reject) => {
    const sink = createWriteStream(out);
    sink.on('finish', resolve).on('error', reject);
    gz.on('error', reject).pipe(sink);
  });
  const write = async (b: Buffer) =>
    new Promise<void>((resolve) => {
      if (gz.write(b)) {
        resolve();
      } else {
        gz.once('drain', resolve);
      }
    });
  for (const e of entries) {
    const data = 'file' in e ? readFileSync(e.file) : Buffer.from(e.text);
    const mode = 'file' in e && anyExecBit(statSync(e.file).mode) ? MODE_EXECUTABLE : MODE_FILE;
    if (Buffer.byteLength(e.path) > NAME_LENGTH) {
      const pax = paxPath(e.path);
      await write(
        Buffer.concat([header('PaxHeader', pax.length, MODE_FILE, 'x'), pax, pad(pax.length)]),
      );
    }
    await write(Buffer.concat([header(e.path, data.length, mode, '0'), data, pad(data.length)]));
  }
  gz.end(Buffer.alloc(END_OF_ARCHIVE));
  await done;
}
