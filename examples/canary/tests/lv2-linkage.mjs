import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const assets = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'ffb-lv2-'));
const bundle = join(work, 'gain.lv2');
const TIMEOUT = 60000;
const MAX_OUTPUT = 8388608;
const SAMPLES = 4096;
const FLOAT_BYTES = 4;
const SAMPLE_PERIOD = 257;
const SAMPLE_MIDDLE = 128;
const SAMPLE_SCALE = 256;
const RATE = 48000;
const QUARTER_GAIN = 0.25;
const NEGATIVE_GAIN = -0.5;
const environment = { ...process.env, LV2_PATH: work, LD_BIND_NOW: '1' };
const command = (program, args) => {
  const result = spawnSync(program, args, {
    env: environment,
    timeout: TIMEOUT,
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
const invoke = (args) =>
  command(ffmpeg, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-filter_threads',
    '1',
    ...args,
  ]);
const source = join(work, 'authored.f32');
const input = Buffer.alloc(SAMPLES * FLOAT_BYTES);
for (let index = 0; index < SAMPLES; index++) {
  input.writeFloatLE(((index % SAMPLE_PERIOD) - SAMPLE_MIDDLE) / SAMPLE_SCALE, index * FLOAT_BYTES);
}
const inputArgs = ['-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', source];
const outputArgs = ['-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'];
const plugin = "lv2=plugin='urn\\:ffmpeg-build\\:test\\:gain'";

const checkSamples = (output, gains) => {
  assert.equal(output.length, input.length * gains.length, 'exact authored samples through EOF');
  for (let index = 0; index < SAMPLES; index++) {
    for (const [channel, gain] of gains.entries()) {
      assert.equal(
        output.readFloatLE((index * gains.length + channel) * FLOAT_BYTES),
        input.readFloatLE(index * FLOAT_BYTES) * gain,
      );
    }
  }
};

const checkElf = () => {
  const folder = dirname(ffmpeg);
  const installed = readdirSync(folder);
  const dynamics = installed
    .filter((name) => /\.so\.\d+$/u.test(name))
    .map((name) => command('readelf', ['-d', join(folder, name)]).toString())
    .join('\n');
  for (const component of ['lilv', 'serd', 'sord', 'sratom', 'zix'].filter((name) =>
    installed.includes(`lib${name}-0.so.0`),
  )) {
    const soname = `lib${component}-0.so.0`;
    const library = join(folder, soname);
    assert.ok(command('readelf', ['-d', library]).toString().includes(`[${soname}]`));
    const symbols = command('nm', ['-D', '--defined-only', library]).toString();
    const other = ['lilv', 'serd', 'sord', 'sratom', 'zix'].filter((name) => name !== component);
    for (const prefix of other) {
      assert.doesNotMatch(symbols, new RegExp(`\\b${prefix}_`, 'u'));
    }
  }
  assert.equal(
    dynamics
      .split('\n')
      .some((line) => line.includes('(NEEDED)') && line.includes('[liblilv-0.so.0]')),
    installed.includes('liblilv-0.so.0'),
  );
};

try {
  mkdirSync(bundle);
  copyFileSync(join(assets, 'lv2-manifest.ttl'), join(bundle, 'manifest.ttl'));
  copyFileSync(join(assets, 'lv2-gain.ttl'), join(bundle, 'gain.ttl'));
  command('cc', [
    '-fPIC',
    '-shared',
    '-fvisibility=hidden',
    '-Wl,-z,defs',
    join(assets, 'lv2-gain.c'),
    '-o',
    join(bundle, 'gain.so'),
  ]);
  writeFileSync(source, input);
  for (const gain of [1, QUARTER_GAIN, NEGATIVE_GAIN]) {
    checkSamples(invoke([...inputArgs, '-af', `${plugin}:controls=gain=${gain}`, ...outputArgs]), [
      gain,
    ]);
  }
  checkSamples(
    invoke([
      ...inputArgs,
      '-filter_complex',
      `[0:a]asplit[a][b];[a]${plugin}:controls=gain=0.25[x];[b]${plugin}:controls=gain=-0.5[y];[x][y]amerge=inputs=2[out]`,
      '-map',
      '[out]',
      ...outputArgs,
    ]),
    [QUARTER_GAIN, NEGATIVE_GAIN],
  );
  const missing = spawnSync(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      ...inputArgs,
      '-af',
      "lv2=plugin='urn\\:ffmpeg-build\\:test\\:missing'",
      ...outputArgs,
    ],
    { env: environment, timeout: TIMEOUT, maxBuffer: MAX_OUTPUT },
  );
  assert.notEqual(missing.status, 0);
  assert.equal(missing.signal, null);
  assert.match(missing.stderr.toString(), /plugin|lv2/iu);
  assert.equal(missing.stdout.length, 0);
  checkElf();
  console.log(
    'LV2: authored plugin discovery, exact gain/EOF, independent instances, missing URI and private ELF closure passed',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
