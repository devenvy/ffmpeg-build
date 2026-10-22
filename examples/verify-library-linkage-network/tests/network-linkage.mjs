import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:tls';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const work = mkdtempSync(join(tmpdir(), 'ffb-network-'));
const MAX_OUTPUT = 4194304;
const SAMPLE_BYTES = 4;
const MIN_SAMPLES = 8000;
const MIN_POWER = 0.001;
const MAX_POWER = 0.02;
const SERVER_START_MS = 500;
const PUBLISH_START_MS = 1200;
const RTMP_PORT = 1935;
const RTMPS_PORT = 1936;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 5000;
const run = (program, args) => {
  const result = spawnSync(program, args, { timeout: 30000, maxBuffer: MAX_OUTPUT });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr?.toString());
  return result.stdout;
};
const flags = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
const audio = ['-f', 'lavfi', '-i', 'sine=frequency=997:sample_rate=16000'];
const verifyAudio = (data) => {
  assert.ok(data.length >= MIN_SAMPLES * SAMPLE_BYTES);
  let power = 0;
  for (let offset = 0; offset < data.length; offset += SAMPLE_BYTES) {
    const sample = data.readFloatLE(offset);
    assert.ok(Number.isFinite(sample));
    power += sample * sample;
  }
  power /= data.length / SAMPLE_BYTES;
  assert.ok(power > MIN_POWER && power < MAX_POWER, `Unexpected audio power: ${power}`);
};
const ssh = 'sftp://ffb:ffb-test-only@127.0.0.1:2222/home/ffb/authored.wav';
run(ffmpeg, [...flags, ...audio, '-t', '1', '-c:a', 'pcm_s16le', '-f', 'wav', ssh]);
verifyAudio(run(ffmpeg, [...flags, '-i', ssh, '-f', 'f32le', '-']));
const wrong = spawnSync(
  ffmpeg,
  [...flags, '-i', ssh.replace('ffb-test-only', 'incorrect-test-password'), '-f', 'null', '-'],
  { timeout: 15000 },
);
assert.equal(wrong.error, undefined);
assert.notEqual(wrong.status, 0, 'Incorrect SSH credentials must fail');
console.log('SFTP upload, download and incorrect-password rejection passed');

writeFileSync(
  join(work, 'nginx.conf'),
  `
load_module /usr/lib/nginx/modules/ngx_rtmp_module.so;
error_log ${work}/nginx.log info;
pid ${work}/nginx.pid;
events { worker_connections 32; }
rtmp { server { listen 127.0.0.1:1935; application live { live on; wait_video off; } } }
`,
);
run('nginx', ['-c', join(work, 'nginx.conf'), '-t']);
const nginx = spawn('nginx', ['-c', join(work, 'nginx.conf'), '-g', 'daemon off;'], {
  stdio: 'ignore',
});
run('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  join(work, 'key.pem'),
  '-out',
  join(work, 'cert.pem'),
  '-days',
  '1',
  '-subj',
  '/CN=localhost',
]);
writeFileSync(
  join(work, 'stunnel.conf'),
  `
foreground = yes
pid =
output = ${work}/stunnel.log
debug = info
[rtmp]
sslVersionMin = TLSv1.3
accept = 127.0.0.1:1936
connect = 127.0.0.1:1935
cert = ${work}/cert.pem
key = ${work}/key.pem
`,
);
const tls = spawn('stunnel', [join(work, 'stunnel.conf')], { stdio: 'ignore' });
const pause = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
let complete = false;
try {
  await pause(SERVER_START_MS);
  for (const [protocol, port] of [
    ['rtmp', RTMP_PORT],
    ['rtmps', RTMPS_PORT],
  ]) {
    const url = `${protocol}://127.0.0.1:${port}/live/authored`;
    const publisher = spawn(
      ffmpeg,
      [...flags, '-re', ...audio, '-t', '20', '-c:a', 'aac', '-f', 'flv', url],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let errors = '';
    publisher.stderr.on('data', (data) => {
      errors += data;
    });
    try {
      await pause(PUBLISH_START_MS);
      assert.equal(publisher.exitCode, null, errors);
      verifyAudio(run(ffmpeg, [...flags, '-i', url, '-t', '1', '-f', 'f32le', '-']));
      console.log(`${protocol.toUpperCase()} live authored-audio round trip passed`);
    } finally {
      publisher.kill('SIGINT');
      await new Promise((resolve) => {
        if (publisher.exitCode !== null) {
          resolve();
        } else {
          publisher.once('exit', resolve);
        }
      });
    }
  }
  assert.match(readFileSync(join(work, 'stunnel.log'), 'utf8'), /TLS accepted/);
  assert.match(readFileSync(join(work, 'stunnel.log'), 'utf8'), /TLSv1\.3 ciphersuite/);
  const sockets = new Set();
  const stalled = createServer(
    {
      key: readFileSync(join(work, 'key.pem')),
      cert: readFileSync(join(work, 'cert.pem')),
      minVersion: 'TLSv1.3',
    },
    (socket) => {
      sockets.add(socket);
      socket.on('data', () => undefined);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    },
  );
  stalled.on('tlsClientError', () => undefined);
  await new Promise((resolve) => {
    stalled.listen(0, '127.0.0.1', resolve);
  });
  try {
    const started = performance.now();
    const timeout = await new Promise((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        [
          ...flags,
          '-i',
          `rtmps://127.0.0.1:${stalled.address().port}/live/stalled timeout=1`,
          '-f',
          'null',
          '-',
        ],
        { timeout: 8000, stdio: 'ignore' },
      );
      child.once('error', reject);
      child.once('exit', (status, signal) => resolve({ status, signal }));
    });
    const elapsed = performance.now() - started;
    assert.equal(timeout.signal, null, 'TLS read must stop itself without an external kill');
    assert.notEqual(timeout.status, 0);
    assert.ok(
      elapsed >= MIN_TIMEOUT_MS && elapsed < MAX_TIMEOUT_MS,
      `Stalled TLS read took ${elapsed}ms`,
    );
    console.log('Real TLS 1.3 stalled application read respected the one-second socket timeout');
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => {
      stalled.close(resolve);
    });
  }
  const files = readdirSync(dirname(ffmpeg));
  const dynamic = files
    .filter((name) => /\.so(?:\.|$)/.test(name))
    .map((name) => run('readelf', ['-d', join(dirname(ffmpeg), name)]).toString())
    .join('\n');
  for (const name of ['ssh', 'rtmp']) {
    const bundled = files.some((file) => new RegExp(`^lib${name}\\.so`).test(file));
    assert.equal(
      new RegExp(`NEEDED.*lib${name}\\.so`).test(dynamic),
      bundled,
      `${name} selected linkage`,
    );
  }
  for (const name of files.filter((file) => /^lib(?:ssh|rtmp)\.so/.test(file))) {
    const exports = run('nm', ['-D', '--defined-only', join(dirname(ffmpeg), name)]).toString();
    assert.doesNotMatch(exports, /\b(?:mbedtls_|gnutls_|nettle_|__gmp|asn1_)/);
  }
  console.log('Networking linkage and private dependency exports passed');
  complete = true;
} finally {
  if (!complete) {
    console.log(readFileSync(join(work, 'stunnel.log'), 'utf8'));
    console.log(readFileSync(join(work, 'nginx.log'), 'utf8'));
  }
  tls.kill('SIGTERM');
  nginx.kill('SIGTERM');
}
