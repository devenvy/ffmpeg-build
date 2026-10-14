import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { tarGz } from './github-fake.ts';
import {
  checkTarMembers,
  extractTarGzFile,
  listTarGzMembers,
  UnsafeArchiveError,
} from '../src/untar.ts';

const archive = (gz: Buffer) => {
  const path = join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-untar-')), 'a.tar.gz');
  writeFileSync(path, gz);
  return path;
};
const dest = () => join(mkdtempSync(join(tmpdir(), 'ffmpeg-build-untar-out-')), 'x');

describe('unpacking an archive from a file', () => {
  it('streams it: files, folders, links, long names', async () => {
    const long = `${'d'.repeat(60)}/${'f'.repeat(60)}.txt`;
    const big = 'x'.repeat(300_000); // spans many reads
    const out = dest();
    await extractTarGzFile(
      archive(
        tarGz([
          { name: 'bin', type: 'dir' },
          { name: 'bin/ffmpeg', data: 'ffmpeg', mode: 0o755 },
          { name: 'big.bin', data: big },
          { name: long, data: 'long' },
          { name: 'libx.so', type: 'symlink', link: 'libx.so.1' },
          { name: 'libx.so.1', data: 'lib' },
        ]),
      ),
      out,
    );
    expect(readFileSync(join(out, 'bin', 'ffmpeg'), 'utf8')).toBe('ffmpeg');
    expect(readFileSync(join(out, 'big.bin'), 'utf8')).toBe(big);
    expect(readFileSync(join(out, long), 'utf8')).toBe('long');
    expect(readFileSync(join(out, 'libx.so'), 'utf8')).toBe('lib');
  });

  it('refuses one past the limits: total size, one file, the number of entries', async () => {
    const files = [
      { name: 'a', data: 'x'.repeat(1000) },
      { name: 'b', data: 'x'.repeat(1000) },
    ];
    await expect(
      extractTarGzFile(archive(tarGz(files)), dest(), { maxTotal: 1500 }),
    ).rejects.toThrow(/more than 1500 bytes unpacked/);
    await expect(extractTarGzFile(archive(tarGz(files)), dest(), { maxFile: 999 })).rejects.toThrow(
      /a: larger than 999 bytes/,
    );
    await expect(
      extractTarGzFile(archive(tarGz(files)), dest(), { maxEntries: 1 }),
    ).rejects.toThrow(/more than 1 entries/);
    await expect(
      extractTarGzFile(archive(tarGz(files)), dest(), {
        maxTotal: 2000,
        maxFile: 1000,
        maxEntries: 2,
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a gzip bomb without inflating it all', async () => {
    // 64 MB of zeros after one small entry header that claims to be huge
    const header = tarGz([{ name: 'a', data: 'x' }]);
    const bomb = gzipSync(
      Buffer.concat([
        Buffer.from(tarHeader('a', 64 * 1024 * 1024)),
        Buffer.alloc(64 * 1024 * 1024),
      ]),
    );
    expect(header.length).toBeGreaterThan(0);
    await expect(
      extractTarGzFile(archive(bomb), dest(), { maxTotal: 1024 * 1024 }),
    ).rejects.toThrow(UnsafeArchiveError);
  });

  it('refuses a cut-short archive, and the same names as before: dotted, absolute, through a link', async () => {
    const whole = tarGz([{ name: 'a', data: 'x'.repeat(5000) }]);
    await expect(
      extractTarGzFile(archive(whole.subarray(0, whole.length - 20)), dest()),
    ).rejects.toThrow(UnsafeArchiveError);
    await expect(
      extractTarGzFile(archive(tarGz([{ name: '../evil', data: 'x' }])), dest()),
    ).rejects.toThrow(/\.\. in its path/);
    await expect(
      extractTarGzFile(archive(tarGz([{ name: '/etc/evil', data: 'x' }])), dest()),
    ).rejects.toThrow(/absolute path/);
    const out = dest();
    await expect(
      extractTarGzFile(
        archive(
          tarGz([
            { name: 'l', type: 'symlink', link: 'sub' },
            { name: 'sub', type: 'dir' },
            { name: 'l/x', data: 'x' },
          ]),
        ),
        out,
      ),
    ).resolves.toBeUndefined();
    expect(existsSync(out)).toBe(true);
    expect(readdirSync(out).sort()).toEqual(['l', 'sub']);
  });

  const badTargets = [
    ['a drive-relative target', 'C:outside'],
    ['a drive-absolute target', 'C:/Windows'],
    ['a drive target with a backslash', 'c:\\Windows'],
    ['an absolute POSIX target', '/etc/passwd'],
    ['a UNC target', '\\\\server\\share'],
    ['a forward-slash UNC target', '//server/share'],
    ['a backslash', 'sub\\x'],
    ['a .. out of the destination', '../../outside'],
    ['a .. out, then back in by name', '../../x/sub/l'],
    ['an empty target', ''],
  ] as const;

  it.each(badTargets)('the extractor refuses a symlink with %s', async (_why, link) => {
    const out = dest();
    await expect(
      extractTarGzFile(
        archive(
          tarGz([
            { name: 'sub', type: 'dir' },
            { name: 'sub/l', type: 'symlink', link },
          ]),
        ),
        out,
      ),
    ).rejects.toThrow(UnsafeArchiveError);
  });

  it.each(badTargets)('the cache-member check refuses a symlink with %s', async (_why, link) => {
    const a = archive(
      tarGz([
        { name: 'sub', type: 'dir' },
        { name: 'sub/l', type: 'symlink', link },
      ]),
    );
    expect(() =>
      checkTarMembers([{ name: 'sub/l', type: 'symlink', link }], dest(), () => false),
    ).toThrow(UnsafeArchiveError);
    const members = await listTarGzMembers(a);
    expect(() => checkTarMembers(members, dest(), () => false)).toThrow(UnsafeArchiveError);
  });

  it('both accept a link down or sideways', async () => {
    const out = dest();
    const entries = [
      { name: 'sub', type: 'dir' as const },
      { name: 'sub/x', data: 'x' },
      { name: 'sub/l', type: 'symlink' as const, link: 'x' },
      { name: 'l2', type: 'symlink' as const, link: 'sub/x' },
    ];
    const a = archive(tarGz(entries));
    expect(() =>
      checkTarMembers(
        [
          { name: 'sub/l', type: 'symlink', link: 'x' },
          { name: 'l2', type: 'symlink', link: 'sub/x' },
        ],
        dest(),
        () => false,
      ),
    ).not.toThrow();
    await expect(extractTarGzFile(a, out)).resolves.toBeUndefined();
    expect(readFileSync(join(out, 'l2'), 'utf8')).toBe('x');
  });

  it('both accept a relative link with .. that resolves inside, as libraries install them (bin/z -> ../lib/libz.so.1)', async () => {
    const out = dest();
    const entries = [
      { name: 'lib', type: 'dir' as const },
      { name: 'lib/libz.so.1', data: 'so' },
      { name: 'bin', type: 'dir' as const },
      { name: 'bin/z', type: 'symlink' as const, link: '../lib/libz.so.1' },
    ];
    expect(() =>
      checkTarMembers(
        [{ name: 'bin/z', type: 'symlink', link: '../lib/libz.so.1' }],
        dest(),
        () => false,
      ),
    ).not.toThrow();
    const members = await listTarGzMembers(archive(tarGz(entries)));
    expect(() => checkTarMembers(members, dest(), () => false)).not.toThrow();
    await expect(extractTarGzFile(archive(tarGz(entries)), out)).resolves.toBeUndefined();
    expect(readFileSync(join(out, 'bin', 'z'), 'utf8')).toBe('so');
  });

  it('both refuse a/b -> ../../outside and C:outside', async () => {
    for (const link of ['../../outside', 'C:outside']) {
      expect(
        () => checkTarMembers([{ name: 'a/b', type: 'symlink', link }], dest(), () => false),
        link,
      ).toThrow(UnsafeArchiveError);
      await expect(
        extractTarGzFile(
          archive(
            tarGz([
              { name: 'a', type: 'dir' },
              { name: 'a/b', type: 'symlink', link },
            ]),
          ),
          dest(),
        ),
        link,
      ).rejects.toThrow(UnsafeArchiveError);
    }
  });

  it('both refuse a .. that passes through another link (resolved by text it stays inside; by the OS it leads out)', async () => {
    // a/l -> .. is the root; b -> a/l/../x would be <root>/../x on disk
    const entries = [
      { name: 'a', type: 'dir' as const },
      { name: 'a/l', type: 'symlink' as const, link: '..' },
      { name: 'b', type: 'symlink' as const, link: 'a/l/../x' },
    ];
    expect(() =>
      checkTarMembers(
        entries.map((e) => ({
          name: e.name,
          type: e.type,
          link: ('link' in e ? e.link : undefined) ?? '',
        })),
        dest(),
        () => false,
      ),
    ).toThrow(/through a link/);
    await expect(extractTarGzFile(archive(tarGz(entries)), dest())).rejects.toThrow(
      /through a link/,
    );
    // and through a link already on disk
    expect(() =>
      checkTarMembers([{ name: 'b', type: 'symlink', link: 'a/../x' }], dest(), (p) =>
        p.endsWith('a'),
      ),
    ).toThrow(/through a link/);
  });
});

/** A ustar header for a file of `size` bytes (its data not included). */
function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) {
    sum += b;
  }
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
