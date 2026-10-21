import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const TIMEOUT = 30000;
const READY_ATTEMPTS = 100;
const READY_DELAY = 100;
const RATE = 48000;
const FLOAT_BYTES = 4;
const MIN_POWER = 0.0001;
const MAX_POWER = 0.1;
const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-jack-'));
const ready = join(work, 'ready');
const start = (command, args) => {
  const child = spawn(command, args, { env: process.env, timeout: TIMEOUT });
  const output = [];
  const errors = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => errors.push(chunk));
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) =>
      status === 0
        ? resolve(Buffer.concat(output))
        : reject(
            new Error(`${command} exited ${status}, signal=${signal}: ${Buffer.concat(errors)}`),
          ),
    );
  });
  done.catch(() => {
    // Promise.all below reports failures after both streams have been started.
  });
  return { child, done };
};
const producer = start('/tmp/ffb-jack-signal', [ready]);
try {
  for (let attempt = 0; attempt < READY_ATTEMPTS && !existsSync(ready); attempt++) {
    await setTimeout(READY_DELAY);
  }
  assert.ok(existsSync(ready), 'The JACK source must connect to the dummy server');
  const capture = start(ffmpeg, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'jack',
    '-channels',
    '1',
    '-i',
    'ffb-capture',
    '-af',
    'asetpts=N/SR/TB',
    '-t',
    '1',
    '-ar',
    String(RATE),
    '-ac',
    '1',
    '-f',
    'f32le',
    '-',
  ]);
  const [samples] = await Promise.all([capture.done, producer.done]);
  assert.equal(samples.length, RATE * FLOAT_BYTES);
  let power = 0;
  for (let offset = 0; offset < samples.length; offset += FLOAT_BYTES) {
    const value = samples.readFloatLE(offset);
    assert.ok(Number.isFinite(value));
    power += value * value;
  }
  power /= RATE;
  assert.ok(power > MIN_POWER && power < MAX_POWER, `JACK input signal power was ${power}`);
  const shared = existsSync(join(dirname(ffmpeg), 'libjack.so.0'));
  const library = readdirSync(dirname(ffmpeg)).find((file) =>
    /^libavdevice\.so\.\d+\.\d+\.\d+$/.test(file),
  );
  assert.ok(library);
  const dynamic = spawnSync('readelf', ['-d', join(dirname(ffmpeg), library)], {
    encoding: 'utf8',
    timeout: TIMEOUT,
  });
  assert.equal(dynamic.status, 0, dynamic.stderr);
  assert.equal(/NEEDED.*libjack\.so/.test(dynamic.stdout), shared);
  const symbols = spawnSync('readelf', ['--dyn-syms', '--wide', join(dirname(ffmpeg), library)], {
    encoding: 'utf8',
    timeout: TIMEOUT,
  });
  assert.equal(symbols.status, 0, symbols.stderr);
  const unwinderOwner = shared
    ? join(dirname(ffmpeg), 'libjack.so.0')
    : join(dirname(ffmpeg), library);
  const unwindSymbols = spawnSync('readelf', ['--dyn-syms', '--wide', unwinderOwner], {
    encoding: 'utf8',
    timeout: TIMEOUT,
  });
  assert.equal(unwindSymbols.status, 0, unwindSymbols.stderr);
  const unwindLines = unwindSymbols.stdout.split('\n').filter((line) => /\b_Unwind_/.test(line));
  assert.ok(unwindLines.length > 0, 'JACK cancellation must use the common system unwinder');
  assert.ok(
    unwindLines.every((line) => /\bUND\b/.test(line) && /@GCC_/.test(line)),
    'glibc cancellation must not cross a private unwinder',
  );
  assert.ok(
    symbols.stdout
      .split('\n')
      .filter((line) => !/\bUND\b/.test(line))
      .every((line) => !/\bjack_\w+(?:@@\S+)?$/.test(line)),
    'Private JACK symbols must not escape FFmpeg’s ABI',
  );
  console.log(`JACK ${shared ? 'shared' : 'static'} dummy-server input passed, power=${power}`);
} finally {
  producer.child.kill();
  rmSync(work, { recursive: true, force: true });
}
