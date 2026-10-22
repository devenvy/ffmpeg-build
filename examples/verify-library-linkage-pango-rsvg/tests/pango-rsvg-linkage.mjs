import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const WIDTH = 256;
const HEIGHT = 96;
const CHANNELS = 4;
const MAX_CHANNEL = 255;
const GRADIENT_Y = 16;
const LEFT_X = 4;
const RIGHT_X = 250;
const HIGH = 240;
const LOW = 16;
const TEXT_TOP = 40;
const TEXT_BOTTOM = 90;
const MAX_DARK = 64;
const MIN_INK = 100;
const TIMEOUT = 30000;
const MAX_BUFFER = 8388608;
const BLUE = 2;
const ALPHA = 3;
const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'ffb-pango-rsvg-'));
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="96">' +
  '<defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>' +
  '<rect width="256" height="96" fill="white"/><rect width="256" height="32" fill="url(#g)"/>' +
  '<text x="12" y="80" font-family="FFB Test" font-size="32">FFB</text></svg>';
try {
  mkdirSync(join(work, 'cache'));
  writeFileSync(
    join(work, 'owned.ttf'),
    Buffer.from(readFileSync(join(here, 'font.base64'), 'utf8').trim(), 'base64'),
  );
  const config = join(work, 'fonts.conf');
  writeFileSync(
    config,
    `<fontconfig><dir>${work}</dir><cachedir>${join(work, 'cache')}</cachedir></fontconfig>`,
  );
  const environment = {
    ...process.env,
    FONTCONFIG_FILE: config,
    G_DEBUG: 'fatal-warnings',
    LD_BIND_NOW: '1',
  };
  const render = (input) => {
    const path = join(work, 'owned.svg');
    writeFileSync(path, input);
    return spawnSync(
      ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'image2',
        '-pattern_type',
        'none',
        '-c:v',
        'librsvg',
        '-i',
        path,
        '-map',
        '0:v:0',
        '-frames:v',
        '1',
        '-pix_fmt',
        'rgba',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      { env: environment, timeout: TIMEOUT, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER },
    );
  };
  const result = render(svg);
  assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stderr}`);
  const pixels = result.stdout;
  assert.equal(pixels.length, WIDTH * HEIGHT * CHANNELS);
  const left = (GRADIENT_Y * WIDTH + LEFT_X) * CHANNELS;
  const right = (GRADIENT_Y * WIDTH + RIGHT_X) * CHANNELS;
  assert.ok(pixels[left] > HIGH && pixels[left + BLUE] < LOW);
  assert.ok(pixels[right + BLUE] > HIGH && pixels[right] < LOW);
  let ink = 0;
  for (let y = TEXT_TOP; y < TEXT_BOTTOM; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const offset = (y * WIDTH + x) * CHANNELS;
      assert.equal(pixels[offset + ALPHA], MAX_CHANNEL);
      if (
        pixels[offset] < MAX_DARK &&
        pixels[offset + 1] < MAX_DARK &&
        pixels[offset + BLUE] < MAX_DARK
      ) {
        ink++;
      }
    }
  }
  assert.ok(ink > MIN_INK, `owned font rendered only ${ink} dark pixels`);
  const invalid = render('<broken');
  assert.notEqual(invalid.status, 0);
  for (const soname of [
    'librsvg-2.so.2',
    'libpango-1.0.so.0',
    'libpangoft2-1.0.so.0',
    'libpangocairo-1.0.so.0',
  ]) {
    const library = join(dirname(ffmpeg), soname);
    if (existsSync(library)) {
      const dynamic = spawnSync('readelf', ['-d', library], { encoding: 'utf8', timeout: TIMEOUT });
      assert.equal(dynamic.status, 0, dynamic.stderr);
      assert.ok(dynamic.stdout.includes(`[${soname}]`));
    }
  }
  console.log(
    'Pango/librsvg: owned SVG gradient/opaque text pixels, missing-input rejection and native library inventory passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
