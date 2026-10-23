import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FIELD = '    int is_restart_needed;\n';
const EOF_FIELD = `${FIELD}    int static_eof;
`;
const REOPEN = '        if (needed && !pls->ctx) {\n';
const BOUNDED_REOPEN = '        if (needed && !pls->ctx && !pls->static_eof) {\n';
const CLOSE = '        } else if (!needed && pls->ctx) {\n';
const BOUNDED_CLOSE = '        } else if (!needed && pls->ctx && !pls->static_eof) {\n';
const CANDIDATE = '        if (!rep->ctx)\n';
const ACTIVE_CANDIDATE = '        if (!rep->ctx || rep->static_eof)\n';
const EOF = `        } else if (ret == AVERROR_EOF) {
            close_demux_for_component(cur);
`;
const STATIC_EOF = `        } else if (ret == AVERROR_EOF) {
            if (!c->is_live) {
                /* Retain the context for seeks; discard belongs to the caller. */
                cur->static_eof = 1;
                return FFERROR_REDO;
            }
            close_demux_for_component(cur);
`;
const DRY_SEEK = '        if (dry_run)\n            return 0;\n';
const RESET_DRY_SEEK = `        if (dry_run) {
            pls->static_eof = 0;
            return 0;
        }
`;
const SINGLE_SEEK = '        return av_seek_frame(pls->ctx, -1, seek_pos_msec * 1000, flags);\n';
const RESET_SINGLE_SEEK = `        ret = av_seek_frame(pls->ctx, -1, seek_pos_msec * 1000, flags);
        if (ret >= 0)
            pls->static_eof = 0;
        return ret;
`;
const MULTI_SEEK = '    ret = dry_run ? 0 : reopen_demux_for_component(s, pls);\n';
const RESET_MULTI_SEEK = `${MULTI_SEEK}    if (ret >= 0)
        pls->static_eof = 0;
`;
const MEDIA_KINDS = 3;
const LEGACY_PACKET = '4ecbf0b2498a1f68b1641f1dbf8795b996e6d3aa6af946179a37fb6b920a3f54';
const CHANGES = [
  [FIELD, EOF_FIELD, 1],
  [REOPEN, BOUNDED_REOPEN, 1],
  [CLOSE, BOUNDED_CLOSE, 1],
  [CANDIDATE, ACTIVE_CANDIDATE, MEDIA_KINDS],
  [EOF, STATIC_EOF, 1],
  [DRY_SEEK, RESET_DRY_SEEK, 1],
  [SINGLE_SEEK, RESET_SINGLE_SEEK, 1],
  [MULTI_SEEK, RESET_MULTI_SEEK, 1],
] as const;
const count = (source: string, text: string) => source.split(text).length - 1;

/** Keep finite DASH representation EOF independent of the caller's stream-discard selection. */
export function fixDashStaticEof(dir: string, configure: readonly string[]): boolean {
  if (!configure.includes('--enable-libxml2')) {
    return false;
  }
  const path = join(dir, 'libavformat', 'dashdec.c');
  const before = readFileSync(path, 'utf8');
  if (CHANGES.every(([, fixed, expected]) => count(before, fixed) === expected)) {
    return false;
  }
  const packet = before.match(/static int dash_read_packet\([\s\S]*?\n}\n/)?.[0];
  // FFmpeg 8 predates d9da090's terminal close/discard path and does not need this repair.
  if (
    packet &&
    createHash('sha256').update(packet).digest('hex') === LEGACY_PACKET &&
    !before.includes('static_eof')
  ) {
    return false;
  }
  if (
    before.includes('static_eof') ||
    !CHANGES.every(([old, , expected]) => count(before, old) === expected)
  ) {
    throw new Error(
      'DASH EOF/seek handling is unrecognized; review the static-representation repair',
    );
  }
  let after = before;
  for (const [old, fixed] of CHANGES) {
    after = after.replaceAll(old, fixed);
  }
  writeFileSync(path, after);
  return true;
}
