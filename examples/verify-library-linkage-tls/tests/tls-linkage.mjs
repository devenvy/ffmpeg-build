import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
  for (const name of ['gmp', 'nettle', 'hogweed', 'tasn1', 'gnutls']) {
    const bundled = files.some((file) => new RegExp(`^lib${name}\\.so`).test(file));
    assert.equal(
      new RegExp(`NEEDED.*lib${name}\\.so`).test(dynamic),
      bundled,
      `${name}: selected static/shared dependency closure`,
    );
  }
  for (const name of files.filter((file) => /^lib(gnutls|hogweed)\.so(?:\.|$)/.test(file))) {
    const exports = run('nm', ['-D', '--defined-only', join(dirname(ffmpeg), name)]).toString();
    assert.doesNotMatch(exports, /\b__gmp\w+/, `${name}: embedded GMP stays private`);
    if (name.startsWith('libgnutls')) {
      assert.doesNotMatch(
        exports,
        /\b(?:nettle_|asn1_)\w+/,
        `${name}: embedded crypto dependencies stay private`,
      );
    }
  }
  console.log(
    'GnuTLS HTTPS: RSA certificate validation, authored audio, unrelated-CA rejection and linkage checks passed',
  );
} finally {
  if (server) {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
  rmSync(work, { recursive: true, force: true });
}
