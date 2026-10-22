import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-tls-linkage-'));
const TIMEOUT = 30000;
const RATE = 16000;
const SAMPLE_BYTES = 4;
const MIN_POWER = 0.001;
const MAX_POWER = 0.02;
const HTTP_OK = 200;
const run = (program, args) => {
  const result = spawnSync(program, args, { timeout: TIMEOUT });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr?.toString());
  return result.stdout;
};
const fetch = (url, ca) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-tls_verify',
        '1',
        '-ca_file',
        ca,
        '-i',
        url,
        '-f',
        'f32le',
        '-',
      ],
      { timeout: TIMEOUT },
    );
    const output = [];
    const errors = [];
    child.stdout.on('data', (data) => output.push(data));
    child.stderr.on('data', (data) => errors.push(data));
    child.on('error', reject);
    child.on('close', (status) =>
      resolve({ status, output: Buffer.concat(output), errors: Buffer.concat(errors).toString() }),
    );
  });
let server;
try {
  for (const name of ['trusted', 'unrelated']) {
    run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(work, `${name}.key`),
      '-out',
      join(work, `${name}.crt`),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ]);
  }
  const media = run(ffmpeg, [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=997:sample_rate=${RATE}:duration=1`,
    '-c:a',
    'pcm_s16le',
    '-f',
    'wav',
    '-',
  ]);
  let requests = 0;
  server = createServer(
    { key: readFileSync(join(work, 'trusted.key')), cert: readFileSync(join(work, 'trusted.crt')) },
    (request, response) => {
      assert.equal(request.url, '/authored.wav');
      requests++;
      response.writeHead(HTTP_OK, { 'Content-Type': 'audio/wav', 'Content-Length': media.length });
      response.end(media);
    },
  );
  server.on('tlsClientError', () => undefined);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `https://127.0.0.1:${server.address().port}/authored.wav`;
  const result = await fetch(url, join(work, 'trusted.crt'));
  assert.equal(result.status, 0, result.errors);
  assert.equal(result.output.length, RATE * SAMPLE_BYTES);
  let power = 0;
  for (let offset = 0; offset < result.output.length; offset += SAMPLE_BYTES) {
    const sample = result.output.readFloatLE(offset);
    assert.ok(Number.isFinite(sample));
    power += sample * sample;
  }
  power /= RATE;
  assert.ok(power > MIN_POWER && power < MAX_POWER);
  assert.ok(requests > 0);
  const wrong = await fetch(url, join(work, 'unrelated.crt'));
  assert.notEqual(wrong.status, 0, 'An unrelated CA must not authenticate the TLS server');
  const files = readdirSync(dirname(ffmpeg));
  const dynamic = files
    .filter((name) => /\.so(?:\.|$)/.test(name))
    .map((name) => run('readelf', ['-d', join(dirname(ffmpeg), name)]).toString())
    .join('\n');
  const buildconf = spawnSync(ffmpeg, ['-buildconf'], { timeout: TIMEOUT });
  assert.equal(buildconf.status, 0);
  const config = `${buildconf.stdout.toString()}\n${buildconf.stderr.toString()}`;
  const backend = ['openssl', 'libtls', 'mbedtls'].find((name) =>
    new RegExp(`--enable-${name}(?:\\s|$)`).test(config),
  );
  assert.ok(backend, 'Exactly one selected TLS backend must be configured');
  const families = {
    openssl: ['ssl', 'crypto'],
    libtls: ['tls', 'ssl', 'crypto'],
    mbedtls: ['mbedtls', 'mbedx509', 'mbedcrypto'],
  }[backend];
  const shared = files.some((file) => new RegExp(`^lib${families[0]}\\.so`).test(file));
  for (const name of families) {
    const bundled = files.some((file) => new RegExp(`^lib${name}\\.so`).test(file));
    assert.equal(bundled, shared, `${backend}: the entire selected suite must be bundled together`);
    assert.equal(
      new RegExp(`NEEDED.*lib${name}\\.so`).test(dynamic),
      bundled,
      `${name}: selected static/shared dependency closure`,
    );
  }
  if (backend === 'openssl' && shared) {
    const relocated = join(work, 'relocated');
    mkdirSync(relocated);
    const crypto = join(relocated, 'libcrypto.so.3');
    copyFileSync(join(dirname(ffmpeg), 'libcrypto.so.3'), crypto);
    const probe = join(relocated, 'provider-probe');
    run('cc', [
      '-Wall',
      '-Wextra',
      '-Werror',
      fileURLToPath(new URL('./openssl-provider.c', import.meta.url)),
      crypto,
      '-Wl,-rpath,$ORIGIN',
      '-o',
      probe,
    ]);
    const env = { ...process.env, OPENSSL_CONF: '/dev/null' };
    delete env.OPENSSL_MODULES;
    delete env.LD_LIBRARY_PATH;
    const providerResult = spawnSync(probe, [], { env, cwd: relocated, timeout: TIMEOUT });
    assert.equal(
      providerResult.status,
      0,
      providerResult.error?.message ?? providerResult.stderr?.toString(),
    );
    console.log(providerResult.stdout.toString().trim());
  }
  console.log(
    `${backend} HTTPS: trusted CA, authored audio, unrelated-CA rejection and linkage checks passed`,
  );
} finally {
  if (server) {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
  rmSync(work, { recursive: true, force: true });
}
