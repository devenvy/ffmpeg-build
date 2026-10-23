import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const TIMEOUT = 60000;
const MAX_OUTPUT = 8388608;
const SECTORS = 750;
const READ_SECTORS = 225;
const FRAMES_PER_SECTOR = 588;
const FRAME_BYTES = 4;
const SAMPLE_BYTES = 2;
const LEFT_PERIOD = 441;
const RIGHT_PERIOD = 293;
const LEFT_RANGE = 40000;
const RIGHT_RANGE = 24000;
const LEFT_OFFSET = 20000;
const RIGHT_OFFSET = 8000;
const work = mkdtempSync(join(tmpdir(), 'ffb-cdio-'));
const environment = { ...process.env, LD_BIND_NOW: '1' };
const command = (program, args) => {
  const result = spawnSync(program, args, {
    env: environment,
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
  assert.equal(
    result.status,
    0,
    `${program}: ${result.error?.message ?? result.stderr?.toString()}`,
  );
  assert.equal(result.signal, null);
  return result.stdout;
};
try {
  const audio = Buffer.alloc(SECTORS * FRAMES_PER_SECTOR * FRAME_BYTES);
  for (let index = 0; index < SECTORS * FRAMES_PER_SECTOR; index++) {
    audio.writeInt16LE(
      Math.floor(((index % LEFT_PERIOD) * LEFT_RANGE) / LEFT_PERIOD) - LEFT_OFFSET,
      index * FRAME_BYTES,
    );
    audio.writeInt16LE(
      Math.floor(((index % RIGHT_PERIOD) * RIGHT_RANGE) / RIGHT_PERIOD) - RIGHT_OFFSET,
      index * FRAME_BYTES + SAMPLE_BYTES,
    );
  }
  writeFileSync(join(work, 'authored.bin'), audio);
  const cue = join(work, 'authored.cue');
  writeFileSync(cue, 'FILE "authored.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n');
  const decoded = command(ffmpeg, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'libcdio',
    '-i',
    cue,
    '-frames:a',
    String(READ_SECTORS),
    '-c:a',
    'pcm_s16le',
    '-f',
    's16le',
    'pipe:1',
  ]);
  const expected = audio.subarray(0, READ_SECTORS * FRAMES_PER_SECTOR * FRAME_BYTES);
  assert.equal(decoded.length, expected.length, '225 complete authored CD sectors');
  assert.deepEqual(
    decoded,
    expected,
    'known little-endian authored stereo samples and channel order',
  );
  const natural = (image) =>
    command(ffmpeg, [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'libcdio',
      '-i',
      image,
      '-c:a',
      'pcm_s16le',
      '-f',
      's16le',
      'pipe:1',
    ]);
  assert.deepEqual(natural(cue), audio, 'all 750 sectors terminate at natural EOF');
  const shortCue = join(work, 'short.cue');
  writeFileSync(join(work, 'short.bin'), expected);
  writeFileSync(shortCue, 'FILE "short.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n');
  assert.deepEqual(natural(shortCue), expected, 'all 225 sectors terminate at natural EOF');
  const tracks = join(work, 'tracks.cue');
  writeFileSync(
    tracks,
    'FILE "authored.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:05:00\n',
  );
  assert.deepEqual(natural(tracks), audio, 'contiguous audio tracks share a complete EOF bound');
  const pregap = join(work, 'pregap.cue');
  writeFileSync(
    pregap,
    'FILE "authored.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 00 00:00:00\n    INDEX 01 00:01:00\n',
  );
  assert.deepEqual(natural(pregap), audio, 'the first audio track retains its nonnegative pregap');
  const missing = spawnSync(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'libcdio',
      '-i',
      join(work, 'missing.cue'),
      '-f',
      'null',
      '-',
    ],
    { env: environment, timeout: TIMEOUT, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT },
  );
  assert.notEqual(missing.status, 0);
  assert.equal(missing.signal, null);
  // libcdio's image drivers print their own missing-file warnings on stdout.
  assert.match(missing.stdout.toString(), /^\+\+ WARN:/u);
  assert.match(missing.stdout.toString(), /missing\.cue/u);
  assert.match(missing.stderr.toString(), /open|drive|device|error/iu);
  const folder = dirname(ffmpeg);
  const installed = readdirSync(folder);
  for (const name of ['libcdio.so.21', 'libiso9660.so.13', 'libudf.so.0']) {
    assert.equal(
      installed.includes(name),
      installed.includes('libcdio.so.21'),
      `${name}: complete native CDIO runtime`,
    );
  }
  assert.equal(
    installed.includes('libcdio_cdda.so.2'),
    installed.includes('libcdio_paranoia.so.2'),
  );
  for (const name of [
    'libcdio.so.21',
    'libiso9660.so.13',
    'libudf.so.0',
    'libcdio_cdda.so.2',
    'libcdio_paranoia.so.2',
  ].filter((candidate) => installed.includes(candidate))) {
    const dynamic = command('readelf', ['-d', join(folder, name)]).toString();
    assert.ok(dynamic.includes(`[${name}]`), `${name}: native SONAME`);
    assert.doesNotMatch(dynamic, /libstdc\+\+\.so/u);
  }
  console.log(
    'CDIO: exact 225/750-sector natural EOF, contiguous audio tracks, initial pregap, missing image and all five native SDK DSOs passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
