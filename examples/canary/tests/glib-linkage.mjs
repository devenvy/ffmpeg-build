import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const assets = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'ffb-glib-'));
const WIDTH = 160;
const HEIGHT = 128;
const CHANNELS = 3;
const BYTE_RANGE = 256;
const TIMEOUT = 60000;
const MAX_OUTPUT = 8388608;
const command = (program, args) => {
  const result = spawnSync(program, args, { timeout: TIMEOUT, maxBuffer: MAX_OUTPUT });
  assert.equal(
    result.status,
    0,
    `${program}: ${result.error?.message ?? result.stderr?.toString()}`,
  );
  assert.equal(result.signal, null);
  return result.stdout;
};
const run = (args) =>
  command(ffmpeg, [
    '-y',
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-filter_threads',
    '1',
    ...args,
  ]);

const lens = () => {
  const frames = 3;
  const X_STEP = 3;
  const Y_STEP = 7;
  const COLOR_STEP = 53;
  const FRAME_STEP = 17;
  const input = Buffer.alloc(WIDTH * HEIGHT * CHANNELS * frames);
  for (let offset = 0; offset < input.length; ++offset) {
    const channel = offset % CHANNELS;
    const pixel = Math.floor(offset / CHANNELS);
    const x = pixel % WIDTH;
    const y = Math.floor(pixel / WIDTH) % HEIGHT;
    const frame = Math.floor(pixel / (WIDTH * HEIGHT));
    input[offset] =
      (x * X_STEP + y * Y_STEP + channel * COLOR_STEP + frame * FRAME_STEP) % BYTE_RANGE;
  }
  const file = join(work, 'lens.rgb');
  writeFileSync(file, input);
  const database = join(work, 'lens-db');
  command('mkdir', ['-p', database]);
  const xml = readFileSync(join(assets, 'glib-lens.xml'), 'utf8');
  const outputs = [];
  for (const coefficient of ['0', '0.15']) {
    writeFileSync(join(database, 'authored.xml'), xml.replace('k1="0.15"', `k1="${coefficient}"`));
    outputs.push(
      run([
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-s',
        `${WIDTH}x${HEIGHT}`,
        '-i',
        file,
        '-vf',
        `lensfun=make=FFB:model=Test Camera:lens_model=Test Lens:db_path=${database}:focal_length=35:aperture=4:focus_distance=10:mode=geometry:scale=1:interpolation=nearest`,
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ]),
    );
  }
  assert.deepEqual(outputs[0], input, 'zero lens calibration preserves all authored pixels');
  assert.equal(
    outputs[1].length,
    input.length,
    'nonzero calibration preserves complete frame count',
  );
  assert.notDeepEqual(outputs[1], input, 'nonzero calibration changes coordinate mapping');
  console.log(
    `lensfun: ${frames} complete frames, identity pixels and nonzero authored calibration passed`,
  );
};

const elf = () => {
  const folder = dirname(ffmpeg);
  const installed = readdirSync(folder);
  const allDynamic = installed
    .filter((name) => /\.so\.\d+$/u.test(name))
    .map((name) => command('readelf', ['-d', join(folder, name)]).toString())
    .join('\n');
  const glibShared = installed.includes('libglib-2.0.so.0');
  for (const component of ['glib', 'gobject', 'gio', 'gmodule', 'gthread', 'girepository']) {
    const soname = `lib${component}-2.0.so.0`;
    assert.equal(
      installed.includes(soname),
      glibShared,
      `${soname}: complete GLib runtime closure`,
    );
    if (glibShared) {
      const dynamic = command('readelf', ['-d', join(folder, soname)]).toString();
      assert.ok(dynamic.includes(`[${soname}]`), `${soname}: native SONAME`);
      assert.doesNotMatch(dynamic, /libstdc\+\+\.so/u);
      const symbols = command('nm', ['-D', '--defined-only', join(folder, soname)]).toString();
      assert.doesNotMatch(
        symbols,
        /\b(?:ffi_|pcre2_)/u,
        `${soname}: embedded dependency API hidden`,
      );
    }
  }
  for (const soname of ['libpcre2-8.so.0', 'libffi.so.8']) {
    const needed = allDynamic
      .split('\n')
      .some((line) => line.includes('(NEEDED)') && line.includes(`[${soname}]`));
    // Lensfun uses GLib utilities; with static GLib it does not pull GObject's
    // closures into FFmpeg. The separate installed SDK probe exercises libffi.
    if (soname === 'libffi.so.8' && !glibShared) {
      assert.ok(!needed || installed.includes(soname), `${soname}: resolved dependency`);
    } else {
      assert.equal(needed, installed.includes(soname), `${soname}: selected mode`);
    }
  }
  assert.equal(installed.includes('libpcre2-posix.so.3'), installed.includes('libpcre2-8.so.0'));
  console.log('GLib: complete selected runtime closure and private dependency exports passed');
};
try {
  lens();
  elf();
} finally {
  rmSync(work, { recursive: true, force: true });
}
