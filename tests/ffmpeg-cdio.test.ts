import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { fixCdioNaturalEof } from '../src/build/ffmpeg-cdio.ts';

// Exact affected statements in the FFmpeg 8.1.3 and 9.0.2 input wrapper.
const affected = `    int32_t last_sector;
} CDIOContext;

static av_cold int read_header
    s->last_sector = cdio_cddap_disc_lastsector(s->drive);
    buf = cdio_paranoia_read(s->paranoia, NULL);
    if (!buf)
        return AVERROR_EOF;
    cdio_paranoia_seek(s->paranoia, timestamp, SEEK_SET);
`;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function source(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ffb-cdio-eof-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'libavdevice'));
  const path = join(dir, 'libavdevice', 'libcdio.c');
  writeFileSync(path, text);
  return { dir, path };
}

it('guards reads before entering native paranoia and advances only after a returned sector', () => {
  const { dir, path } = source(affected);
  expect(fixCdioNaturalEof(dir, ['--enable-libcdio'])).toBe(true);
  const fixed = readFileSync(path, 'utf8');
  expect(fixed).toContain('int64_t next_sector;');
  expect(fixed).toContain('sector < s->first_sector || sector > s->last_sector');
  expect(fixed).toMatch(/is_audio_sector\(s, s->next_sector\)[\s\S]*AVERROR_EOF;\n\n {4}buf =/);
  expect(fixed).toContain('if (!buf)\n        return AVERROR_EOF;\n    s->next_sector++;');
  expect(fixCdioNaturalEof(dir, ['--enable-libcdio'])).toBe(false);
});

it('preserves audio pregaps, rejects data sectors, and uses the requested seek cursor', () => {
  const { dir, path } = source(`/* header */\n${affected}\n/* tail */\n`);
  fixCdioNaturalEof(dir, ['--enable-libcdio']);
  const fixed = readFileSync(path, 'utf8');
  expect(fixed).toContain('if (track == 0)\n        track = s->drive->disc_toc[0].bTrack;');
  expect(fixed).toContain('track >= CDIO_INVALID_TRACK');
  expect(fixed).toContain('cdio_cddap_track_audiop(s->drive, track) == 1');
  expect(fixed).toContain('if (!is_audio_sector(s, timestamp))\n        return AVERROR(EINVAL);');
  expect(fixed).toContain('s->next_sector = timestamp;');
  expect(fixed.startsWith('/* header */\n')).toBe(true);
  expect(fixed.endsWith('\n/* tail */\n')).toBe(true);
});

it('does not access CDIO sources unless selected', () => {
  expect(fixCdioNaturalEof('/missing/source', [])).toBe(false);
});

it.each([
  `${affected}    int64_t next_sector;\n`,
  affected.replace('int32_t last_sector;', 'int64_t last_sector;'),
  affected.replace(
    'cdio_paranoia_read(s->paranoia, NULL)',
    'cdio_paranoia_read_limited(s->paranoia, NULL, 8)',
  ),
  affected + affected,
])('rejects partial or changed sources before writing', (text) => {
  const { dir, path } = source(text);
  expect(() => fixCdioNaturalEof(dir, ['--enable-libcdio'])).toThrow(/CDIO.*unrecognized/);
  expect(readFileSync(path, 'utf8')).toBe(text);
});
