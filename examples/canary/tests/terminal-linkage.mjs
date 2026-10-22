import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const TIMEOUT = 60000;
const MAX_OUTPUT = 8388608;
const WIDTH = 80;
const HEIGHT = 24;
const FRAME_COUNT = 3;
const HEADER_BYTES = 52;
const CANVAS_HEADER_BYTES = 48;
const CELL_BYTES = 8;
const WORD_BYTES = 4;
const VERSION_OFFSET = 12;
const FRAME_COUNT_OFFSET = 14;
const WIDTH_OFFSET = 20;
const HEIGHT_OFFSET = 24;
const ASCII_MINIMUM = 32;
const ASCII_MAXIMUM = 126;
const MAGIC = Buffer.from('caca4356', 'hex');
const NCURSES_LIBRARIES = ['libncursesw.so.6', 'libpanelw.so.6', 'libmenuw.so.6', 'libformw.so.6'];
const work = mkdtempSync(join(tmpdir(), 'ffb-terminal-'));
const environment = { ...process.env, LD_BIND_NOW: '1' };
const execute = (program, args) =>
  spawnSync(program, args, {
    env: environment,
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
const command = (program, args) => {
  const result = execute(program, args);
  assert.equal(
    result.status,
    0,
    `${program}: ${result.error?.message ?? result.stderr?.toString()}`,
  );
  assert.equal(result.signal, null);
  return result.stdout;
};
const render = (driver) => [
  '-hide_banner',
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=64x32:rate=5',
  '-frames:v',
  String(FRAME_COUNT),
  '-pix_fmt',
  'rgb24',
  '-f',
  'caca',
  '-driver',
  driver,
  '-window_size',
  `${WIDTH}x${HEIGHT}`,
  '-charset',
  'ascii',
  '-algorithm',
  'none',
  '-antialias',
  'none',
  'owned',
];
try {
  const raw = command(ffmpeg, render('raw'));
  const canvasBytes = WIDTH * HEIGHT * CELL_BYTES;
  const frameBytes = HEADER_BYTES + canvasBytes;
  assert.equal(raw.length, FRAME_COUNT * frameBytes);
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const start = frame * frameBytes;
    assert.deepEqual(raw.subarray(start, start + WORD_BYTES), MAGIC);
    assert.equal(raw.readUInt32BE(start + WORD_BYTES), CANVAS_HEADER_BYTES);
    assert.equal(raw.readUInt32BE(start + CELL_BYTES), canvasBytes);
    assert.equal(raw.readUInt16BE(start + VERSION_OFFSET), 1);
    assert.equal(raw.readUInt32BE(start + FRAME_COUNT_OFFSET), 1);
    assert.equal(raw.readUInt32BE(start + WIDTH_OFFSET), WIDTH);
    assert.equal(raw.readUInt32BE(start + HEIGHT_OFFSET), HEIGHT);
    const characters = new Set();
    const attributes = new Set();
    for (let offset = start + HEADER_BYTES; offset < start + frameBytes; offset += CELL_BYTES) {
      const character = raw.readUInt32BE(offset);
      assert.ok(character >= ASCII_MINIMUM && character <= ASCII_MAXIMUM);
      characters.add(character);
      attributes.add(raw.readUInt32BE(offset + WORD_BYTES));
    }
    assert.ok(
      characters.size > 1 && attributes.size > 1,
      'Owned test pattern must produce structured colored cells',
    );
  }
  const transcript = join(work, 'ncurses-output.bin');
  command('python3', [
    join(dirname(fileURLToPath(import.meta.url)), 'terminal-pty.py'),
    transcript,
    ffmpeg,
    ...render('ncurses'),
  ]);
  const terminal = readFileSync(transcript);
  assert.ok(
    terminal.length > 0 && terminal.includes(Buffer.from('\u001b[')),
    'Ncurses must draw through the owned PTY',
  );
  command(ffmpeg, render('null'));
  const invalid = execute(ffmpeg, render('ffb_missing_driver'));
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.signal, null);
  assert.match(invalid.stderr.toString(), /display|driver|error/iu);
  const installed = readdirSync(dirname(ffmpeg));
  for (const name of NCURSES_LIBRARIES) {
    assert.equal(
      installed.includes(name),
      installed.includes('libncursesw.so.6'),
      `${name}: complete curses runtime`,
    );
  }
  for (const name of [...NCURSES_LIBRARIES, 'libcaca.so.0'].filter((candidate) =>
    installed.includes(candidate),
  )) {
    const library = join(dirname(ffmpeg), name);
    const dynamic = command('readelf', ['-d', library]).toString();
    assert.ok(dynamic.includes(`[${name}]`));
    assert.doesNotMatch(dynamic, /libgpm|libstdc\+\+\.so/u);
    if (name === 'libcaca.so.0') {
      const exports = command('nm', ['-D', '--defined-only', library]).toString();
      assert.doesNotMatch(
        exports,
        /\b(?:stdscr|cur_term|initscr|wrefresh|COLS|LINES|inflate\w*|deflate\w*|adler32\w*|crc32\w*)\b/u,
      );
    }
  }
  console.log(
    'Terminal: three authored80x24 raw canvases, colored ASCII cells, ncurses PTY drawing/restoration, null-driver EOF, invalid driver and complete/private ELF closure passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
