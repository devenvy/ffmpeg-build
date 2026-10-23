import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FIELDS = '    int32_t last_sector;\n';
const BOUNDED_FIELDS = `${FIELDS}    int32_t first_sector;
    int64_t next_sector;
`;
const HEADER = '} CDIOContext;\n\nstatic av_cold int read_header';
const AUDIO_SECTOR = `} CDIOContext;

/* Bound native paranoia reads to the available audio region. */
static int is_audio_sector(CDIOContext *s, int64_t sector)
{
    int track;

    if (sector < s->first_sector || sector > s->last_sector)
        return 0;
    track = cdio_cddap_sector_gettrack(s->drive, (int32_t)sector);
    /* Track zero denotes the initial pregap, which belongs to the first track. */
    if (track == 0)
        track = s->drive->disc_toc[0].bTrack;
    if (track <= 0 || track >= CDIO_INVALID_TRACK)
        return 0;
    return cdio_cddap_track_audiop(s->drive, track) == 1;
}

static av_cold int read_header`;
const LAST = '    s->last_sector = cdio_cddap_disc_lastsector(s->drive);\n';
const RANGE = `${LAST}    s->first_sector = cdio_cddap_disc_firstsector(s->drive);
    if (s->first_sector < 0 || s->last_sector < s->first_sector)
        return AVERROR(EIO);
    s->next_sector = s->first_sector;
    if (!is_audio_sector(s, s->next_sector))
        return AVERROR(EINVAL);
`;
const READ = '    buf = cdio_paranoia_read(s->paranoia, NULL);\n';
const BOUNDED_READ = `    if (!is_audio_sector(s, s->next_sector))
        return AVERROR_EOF;

${READ}`;
const EMPTY = '    if (!buf)\n        return AVERROR_EOF;\n';
const ADVANCE = `${EMPTY}    s->next_sector++;
`;
const SEEK = '    cdio_paranoia_seek(s->paranoia, timestamp, SEEK_SET);\n';
const BOUNDED_SEEK = `    if (!is_audio_sector(s, timestamp))
        return AVERROR(EINVAL);
    /* The native return value is the previous cursor, not the requested one. */
    if (cdio_paranoia_seek(s->paranoia, (int32_t)timestamp, SEEK_SET) < 0)
        return AVERROR(EIO);
    s->next_sector = timestamp;
`;
const CHANGES = [
  [FIELDS, BOUNDED_FIELDS],
  [HEADER, AUDIO_SECTOR],
  [LAST, RANGE],
  [READ, BOUNDED_READ],
  [EMPTY, ADVANCE],
  [SEEK, BOUNDED_SEEK],
] as const;
const once = (source: string, text: string) =>
  source.includes(text) && source.indexOf(text) === source.lastIndexOf(text);

/** Bound the opt-in CDIO input to audio sectors and preserve its cursor across seeks. */
export function fixCdioNaturalEof(dir: string, configure: readonly string[]): boolean {
  if (!configure.includes('--enable-libcdio')) {
    return false;
  }
  const path = join(dir, 'libavdevice', 'libcdio.c');
  const before = readFileSync(path, 'utf8');
  if (CHANGES.every(([, fixed]) => once(before, fixed))) {
    return false;
  }
  if (before.includes('next_sector') || !CHANGES.every(([old]) => once(before, old))) {
    throw new Error('CDIO sector handling is unrecognized; review the natural-EOF repair');
  }
  let after = before;
  for (const [old, fixed] of CHANGES) {
    after = after.replace(old, fixed);
  }
  writeFileSync(path, after);
  return true;
}
