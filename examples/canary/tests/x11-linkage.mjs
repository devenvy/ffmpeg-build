import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const TIMEOUT = 60000;
const MAX_OUTPUT = 8388608;
const COOKIE_BYTES = 16;
const WIDTH = 128;
const HEIGHT = 96;
const SCREEN_WIDTH = 320;
const SCREEN_HEIGHT = 240;
const CHANNELS = 3;
const FRAME_COUNT = 3;
const RED_MINIMUM = 240;
const OTHER_MAXIMUM = 5;
const MAX_CURSOR_PIXELS = 1000;
const XCB_LIBRARIES = [
  'libxcb.so.1',
  'libxcb-composite.so.0',
  'libxcb-damage.so.0',
  'libxcb-dbe.so.0',
  'libxcb-dpms.so.0',
  'libxcb-dri2.so.0',
  'libxcb-dri3.so.0',
  'libxcb-glx.so.0',
  'libxcb-present.so.0',
  'libxcb-randr.so.0',
  'libxcb-record.so.0',
  'libxcb-render.so.0',
  'libxcb-res.so.0',
  'libxcb-screensaver.so.0',
  'libxcb-shape.so.0',
  'libxcb-shm.so.0',
  'libxcb-sync.so.1',
  'libxcb-xf86dri.so.0',
  'libxcb-xfixes.so.0',
  'libxcb-xinerama.so.0',
  'libxcb-xinput.so.0',
  'libxcb-xkb.so.1',
  'libxcb-xtest.so.0',
  'libxcb-xv.so.0',
  'libxcb-xvmc.so.0',
];
const work = mkdtempSync(join(tmpdir(), 'ffb-x11-'));
const environment = { ...process.env, LD_BIND_NOW: '1' };
const authority = join(work, 'client.auth');
let server;
const execute = (program, args, extra = {}) =>
  spawnSync(program, args, {
    env: { ...environment, ...(program === ffmpeg ? {} : { LD_LIBRARY_PATH: '' }), ...extra },
    timeout: TIMEOUT,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_OUTPUT,
  });
const command = (program, args, extra) => {
  const result = execute(program, args, extra);
  assert.equal(
    result.status,
    0,
    `${program}: ${result.error?.message ?? result.stderr?.toString()}`,
  );
  assert.equal(result.signal, null);
  return result.stdout;
};
const red = (pixels, offset) =>
  pixels[offset] >= RED_MINIMUM &&
  pixels[offset + 1] <= OTHER_MAXIMUM &&
  pixels[offset + CHANNELS - 1] <= OTHER_MAXIMUM;
try {
  const cookie = randomBytes(COOKIE_BYTES).toString('hex');
  const serverAuthority = join(work, 'server.auth');
  command('xauth', ['-f', serverAuthority, 'add', ':0', 'MIT-MAGIC-COOKIE-1', cookie]);
  server = spawn(
    'Xvfb',
    [
      '-displayfd',
      '3',
      '-screen',
      '0',
      `${SCREEN_WIDTH}x${SCREEN_HEIGHT}x24`,
      '-auth',
      serverAuthority,
      '-noreset',
      '-nolisten',
      'tcp',
    ],
    {
      env: { ...environment, LD_LIBRARY_PATH: '' },
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
    },
  );
  let serverErrors = '';
  server.stderr.on('data', (chunk) => {
    serverErrors += chunk.toString();
  });
  const [displayChunk] = await once(server.stdio[CHANNELS], 'data', {
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const number = displayChunk.toString().trim();
  assert.match(number, /^\d+$/u, serverErrors);
  const display = `:${number}`;
  command('xauth', ['-f', authority, 'add', display, 'MIT-MAGIC-COOKIE-1', cookie]);
  environment.DISPLAY = display;
  environment.XAUTHORITY = authority;
  command('xdpyinfo', []);
  command('xsetroot', ['-solid', '#ff0000']);
  command('xdotool', ['mousemove', '100', '100']);
  const grab = (width, height, mouse, region) =>
    command(ffmpeg, [
      '-hide_banner',
      '-v',
      'error',
      '-f',
      'x11grab',
      '-framerate',
      '20',
      '-video_size',
      `${width}x${height}`,
      '-draw_mouse',
      String(mouse),
      '-show_region',
      String(region),
      '-i',
      `${display}+16,16`,
      '-frames:v',
      String(FRAME_COUNT),
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ]);
  const plain = grab(WIDTH, HEIGHT, 0, 0);
  assert.equal(plain.length, FRAME_COUNT * WIDTH * HEIGHT * CHANNELS);
  for (let offset = 0; offset < plain.length; offset += CHANNELS) {
    assert.ok(red(plain, offset), `Owned root pixel ${offset}`);
  }
  const cursor = grab(WIDTH, HEIGHT, 1, 0);
  assert.equal(cursor.length, plain.length);
  let changed = 0;
  for (let offset = 0; offset < WIDTH * HEIGHT * CHANNELS; offset += CHANNELS) {
    if (!red(cursor, offset)) {
      changed++;
    }
  }
  assert.ok(changed > 0 && changed < MAX_CURSOR_PIXELS, `Cursor pixels ${changed}`);
  assert.equal(grab(WIDTH, HEIGHT, 0, 1).length, plain.length);
  const wrongAuthority = join(work, 'wrong.auth');
  command('xauth', [
    '-f',
    wrongAuthority,
    'add',
    display,
    'MIT-MAGIC-COOKIE-1',
    randomBytes(COOKIE_BYTES).toString('hex'),
  ]);
  const rejected = execute(
    ffmpeg,
    [
      '-hide_banner',
      '-v',
      'error',
      '-f',
      'x11grab',
      '-i',
      display,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ],
    { XAUTHORITY: wrongAuthority },
  );
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.signal, null);
  assert.match(rejected.stderr.toString(), /display|authori|cookie|error/iu);
  const xv = execute(ffmpeg, [
    '-hide_banner',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=64x64',
    '-frames:v',
    '1',
    '-f',
    'xv',
    'FFB_owned_XVideo',
  ]);
  assert.notEqual(xv.status, 0);
  assert.equal(xv.signal, null);
  assert.match(xv.stderr.toString(), /port|xvideo|adaptor|adapter/iu);
  const installed = readdirSync(dirname(ffmpeg));
  for (const name of XCB_LIBRARIES) {
    assert.equal(
      installed.includes(name),
      installed.includes('libxcb.so.1'),
      `${name}: complete native XCB runtime`,
    );
  }
  assert.equal(installed.includes('libX11.so.6'), installed.includes('libX11-xcb.so.1'));
  for (const name of installed.filter((candidate) =>
    /^lib(?:Xau|xcb[^.]*|X11(?:-xcb)?|Xext|Xv)\.so\.\d+$/u.test(candidate),
  )) {
    const dynamic = command('readelf', ['-d', join(dirname(ffmpeg), name)]).toString();
    assert.ok(dynamic.includes(`[${name}]`));
    assert.doesNotMatch(dynamic, /libstdc\+\+\.so/u);
    if (name === 'libxcb.so.1') {
      const exports = command('nm', [
        '-D',
        '--defined-only',
        join(dirname(ffmpeg), name),
      ]).toString();
      assert.doesNotMatch(exports, /\bXau\w+/u, 'Embedded static Xau stays private');
    }
  }
  console.log(
    'X11: authenticated owned red pixels, XFixes cursor, region-outline path, wrong-cookie rejection and bounded Xv no-adaptor open passed; no XVideo output claimed',
  );
} finally {
  if (server && server.exitCode === null) {
    const finished = once(server, 'exit');
    server.kill('SIGKILL');
    await finished;
  }
  rmSync(work, { recursive: true, force: true });
}
