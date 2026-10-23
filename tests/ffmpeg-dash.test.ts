import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { fixDashStaticEof } from '../src/build/ffmpeg-dash.ts';

// Exact affected statements from FFmpeg 9.0.2; live EOF cleanup remains unchanged.
const MEDIA_KINDS = 3;
const affected = `    int is_restart_needed;
        if (needed && !pls->ctx) {
        } else if (!needed && pls->ctx) {
        if (!rep->ctx)
        if (!rep->ctx)
        if (!rep->ctx)
        } else if (ret == AVERROR_EOF) {
            close_demux_for_component(cur);
            ff_format_io_close(cur->parent, &cur->input);
            cur->assoc_stream[i]->discard = AVDISCARD_ALL;
        if (dry_run)
            return 0;
        return av_seek_frame(pls->ctx, -1, seek_pos_msec * 1000, flags);
    ret = dry_run ? 0 : reopen_demux_for_component(s, pls);
`;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
function source(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ffb-dash-eof-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'libavformat'));
  const path = join(dir, 'libavformat', 'dashdec.c');
  writeFileSync(path, text);
  return { dir, path };
}

it('separates static EOF from stream selection and keeps the existing live EOF cleanup', () => {
  const { dir, path } = source(affected);
  expect(fixDashStaticEof(dir, ['--enable-libxml2'])).toBe(true);
  const fixed = readFileSync(path, 'utf8');
  expect(fixed).toContain('if (!c->is_live)');
  expect(fixed).toContain('cur->static_eof = 1;\n                return FFERROR_REDO;');
  expect(fixed).toContain(
    'close_demux_for_component(cur);\n            ff_format_io_close(cur->parent, &cur->input);',
  );
  expect(fixed).toContain('cur->assoc_stream[i]->discard = AVDISCARD_ALL;');
  expect(fixed.split('if (!rep->ctx || rep->static_eof)').length - 1).toBe(MEDIA_KINDS);
  expect(fixed).toContain('!needed && pls->ctx && !pls->static_eof');
  expect(fixDashStaticEof(dir, ['--enable-libxml2'])).toBe(false);
});

it('clears EOF only after successful real seeks or the successful dry-run path', () => {
  const { dir, path } = source(affected);
  fixDashStaticEof(dir, ['--enable-libxml2']);
  const fixed = readFileSync(path, 'utf8');
  expect(fixed).toContain(
    'if (dry_run) {\n            pls->static_eof = 0;\n            return 0;',
  );
  expect(fixed).toContain('if (ret >= 0)\n            pls->static_eof = 0;');
  expect(fixed).toContain('if (ret >= 0)\n        pls->static_eof = 0;');
});

it('leaves the older input without a terminal-close path unchanged', () => {
  const legacy = readFileSync(new URL('./fixtures/dash-packet-8.txt', import.meta.url), 'utf8');
  const { dir, path } = source(legacy);
  expect(fixDashStaticEof(dir, ['--enable-libxml2'])).toBe(false);
  expect(readFileSync(path, 'utf8')).toBe(legacy);
});

it('does not read sources unless libxml2 is selected', () => {
  expect(fixDashStaticEof('/missing/source', [])).toBe(false);
});

it.each([
  'static int dash_read_packet(AVFormatContext *s, AVPacket *pkt)\n{\n    return ret;\n}\n',
  `${affected}    int static_eof;\n`,
  affected.replace('    int is_restart_needed;', '    int is_restart_needed, other;'),
  affected.replace('        if (!rep->ctx)\n', ''),
  affected + affected,
])('rejects partial or changed affected constructions before writing', (text) => {
  const { dir, path } = source(text);
  expect(() => fixDashStaticEof(dir, ['--enable-libxml2'])).toThrow(/DASH.*unrecognized/);
  expect(readFileSync(path, 'utf8')).toBe(text);
});
