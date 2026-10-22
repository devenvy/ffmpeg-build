import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-iconv-'));
const LATIN9_E_ACUTE = 0xe9;
const LATIN9_EURO = 0xa4;
try {
  const path = join(work, 'owned.srt');
  const header = '1\n00:00:00,000 --> 00:00:01,000\n';
  const text = 'café €';
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from(`${header}caf`, 'ascii'),
      Buffer.from([LATIN9_E_ACUTE]),
      Buffer.from(' ', 'ascii'),
      Buffer.from([LATIN9_EURO]),
      Buffer.from('\n\n', 'ascii'),
    ]),
  );
  const execute = (encoding) =>
    spawnSync(
      ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-sub_charenc',
        encoding,
        '-f',
        'srt',
        '-i',
        path,
        '-c:s',
        'srt',
        '-f',
        'srt',
        'pipe:1',
      ],
      { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' },
    );
  const result = execute('ISO-8859-15');
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.replaceAll('\r\n', '\n'), `${header}${text}\n\n`);
  const invalid = execute('ffmpeg-build-invalid-encoding');
  assert.equal(invalid.error, undefined);
  assert.ok(invalid.status !== 0 && invalid.status !== null, invalid.stderr);
  if (existsSync(join(dirname(ffmpeg), 'libiconv.2.dylib'))) {
    const dynamic = spawnSync('otool', ['-L', ffmpeg], { encoding: 'utf8', timeout: 30000 });
    assert.equal(dynamic.status, 0, dynamic.stderr);
    assert.ok(dynamic.stdout.includes('@rpath/libiconv.2.dylib'), dynamic.stdout);
  }
  console.log(
    'GNU iconv: exact owned Latin-9 subtitles, UTF-8 euro/accent bytes and invalid encoding rejection passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
