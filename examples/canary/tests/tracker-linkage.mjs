import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-tracker-'));
const TIMEOUT = 120000;
const MAX_OUTPUT = 8388608;
const RATE = 48000;
const FLOAT_BYTES = 4;
const MIN_SECONDS = 7;
const MAX_SECONDS = 9;
const MIN_POWER = 0.00001;
const MAX_POWER = 0.4;
const SAMPLE_COUNT = 64;
const SAMPLE_AMPLITUDE = 90;
const TWO_PI = Math.PI + Math.PI;
const WORD_BYTES = 2;
const MOD = {
  headerBytes: 1084,
  patternBytes: 1024,
  sampleLength: 42,
  volume: 45,
  loopLength: 48,
  orders: 950,
  restart: 951,
  signature: 1080,
  volumeMax: 64,
  restartNone: 127,
};
const FIRST_NOTE = Buffer.from('01ac1000', 'hex');
const FLAGS = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
const run = (program, args, input) => {
  const result = spawnSync(program, args, { input, timeout: TIMEOUT, maxBuffer: MAX_OUTPUT });
  assert.deepEqual(
    { status: result.status, signal: result.signal },
    { status: 0, signal: null },
    `${program} ${args.join(' ')}: ${result.error?.message ?? result.stderr?.toString()}`,
  );
  return result.stdout;
};
try {
  const module = Buffer.alloc(MOD.headerBytes + MOD.patternBytes + SAMPLE_COUNT);
  module.write('FFB own module');
  module.writeUInt16BE(SAMPLE_COUNT / WORD_BYTES, MOD.sampleLength);
  module[MOD.volume] = MOD.volumeMax;
  module.writeUInt16BE(SAMPLE_COUNT / WORD_BYTES, MOD.loopLength);
  module[MOD.orders] = 1;
  module[MOD.restart] = MOD.restartNone;
  module.write('M.K.', MOD.signature);
  FIRST_NOTE.copy(module, MOD.headerBytes);
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    module.writeInt8(
      Math.round(SAMPLE_AMPLITUDE * Math.sin((TWO_PI * sample) / SAMPLE_COUNT)),
      MOD.headerBytes + MOD.patternBytes + sample,
    );
  }
  const input = join(work, 'authored.mod');
  writeFileSync(input, module);
  for (const format of ['libmodplug', 'libopenmpt']) {
    const decoded = run(ffmpeg, [
      ...FLAGS,
      '-f',
      format,
      '-i',
      input,
      '-ar',
      String(RATE),
      '-ac',
      '1',
      '-f',
      'f32le',
      '-',
    ]);
    assert.equal(decoded.length % FLOAT_BYTES, 0);
    const seconds = decoded.length / FLOAT_BYTES / RATE;
    assert.ok(
      seconds >= MIN_SECONDS && seconds <= MAX_SECONDS,
      `${format}: complete finite EOF ${seconds}`,
    );
    let energy = 0;
    for (let offset = 0; offset < decoded.length; offset += FLOAT_BYTES) {
      const sample = decoded.readFloatLE(offset);
      assert.ok(Number.isFinite(sample));
      energy += sample * sample;
    }
    const power = energy / (decoded.length / FLOAT_BYTES);
    assert.ok(power > MIN_POWER && power < MAX_POWER, `${format}: authored sample power ${power}`);
    const rejected = spawnSync(ffmpeg, [...FLAGS, '-f', format, '-i', '-', '-f', 'null', '-'], {
      input: Buffer.from('not a tracker module'),
      timeout: TIMEOUT,
      maxBuffer: MAX_OUTPUT,
    });
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.signal, null);
    console.log(
      `${format}: authored module, complete EOF ${decoded.length / FLOAT_BYTES} samples, and invalid-input rejection passed`,
    );
  }
  const files = readdirSync(dirname(ffmpeg));
  const dynamic = files
    .filter((name) => /\.so(?:\.|$)/.test(name))
    .map((name) => run('readelf', ['-d', join(dirname(ffmpeg), name)]).toString())
    .join('\n');
  for (const name of ['modplug', 'openmpt']) {
    const bundled = files.some((file) => new RegExp(`^lib${name}\\.so`).test(file));
    assert.equal(
      new RegExp(`NEEDED.*lib${name}\\.so`).test(dynamic),
      bundled,
      `${name}: selected linkage`,
    );
  }
  // Static PulseAudio drops its unused sample-upload objects from FFmpeg's link;
  // its shared private library retains the libsndfile calls. The recipe's direct
  // installed C API probe covers the selected provider in either case.
  const bundledSndfile = files.some((file) => /^libsndfile\.so/.test(file));
  const sharedPulseCommon = files.some((file) => /^libpulsecommon.*\.so/.test(file));
  assert.equal(/NEEDED.*libsndfile\.so/.test(dynamic), bundledSndfile && sharedPulseCommon);
  for (const name of files.filter((file) => /^lib(modplug|openmpt)\.so(?:\.|$)/.test(file))) {
    const file = join(dirname(ffmpeg), name);
    assert.match(run('readelf', ['-d', file]).toString(), /NEEDED.*libstdc\+\+\.so\.6/);
    const symbols = run('nm', ['-D', '--defined-only', file]).toString();
    if (name.startsWith('libopenmpt.')) {
      // The native shared compiler runtime supplies exception state and unwinding for SDK callers.
      assert.doesNotMatch(symbols, /\b(?:__cxa_get_globals|_Unwind_\w+)\b/);
    } else {
      assert.doesNotMatch(symbols, /\b(?:_Z(?:St|N[KVO]?St|T[ISV]St)|__cxa_|_Unwind_)\w+/);
    }
  }
  console.log('Selected tracker/audio ELF dependencies and native compiler ABI boundaries passed');
} finally {
  rmSync(work, { recursive: true, force: true });
}
