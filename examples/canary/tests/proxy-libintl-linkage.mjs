import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
await import('./pixman-linkage.mjs');
const library = join(dirname(ffmpeg), 'libintl.so.8');
if (existsSync(library)) {
  const dynamic = spawnSync('readelf', ['-d', library], { encoding: 'utf8', timeout: 30000 });
  assert.equal(dynamic.status, 0, dynamic.stderr);
  assert.ok(dynamic.stdout.includes('[libintl.so.8]'), dynamic.stdout);
  const symbols = spawnSync('nm', ['-D', '--defined-only', library], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(symbols.status, 0, symbols.stderr);
  assert.match(symbols.stdout, /\bg_libintl_textdomain\b/);
  assert.match(symbols.stdout, /\b_nl_msg_cat_cntr\b/);
}
console.log(
  'Proxy gettext: native musl SONAME/public mutable data and actual GLib/Cairo-backed pixels passed',
);
