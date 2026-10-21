import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as httpsServer } from 'node:https';
import { createServer as tcpServer } from 'node:net';

const ff = process.env.FFMPEG;
const RTMP_HANDSHAKE_SIZE = 1537;
const RTMP_ENCRYPTED_VERSION = 6;
let r;
async function command(args) {
  const p = spawn(ff, args, { timeout: 10000 });
  let output = '';
  p.stderr.on('data', (d) => (output += d));
  p.stdout.on('data', (d) => (output += d));
  const status = await new Promise((resolve) => {
    p.on('close', resolve);
  });
  return { status, output };
}
if (!process.argv.includes('--rtmpe-only')) {
  r = spawnSync(
    ff,
    [
      '-hide_banner',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=0.2',
      '-c:a',
      'pcm_s16le',
      `${process.env.FFB_CRYPTO_TEST_TMP}/tone.wav`,
      '-y',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  const srv = httpsServer(
    {
      key: readFileSync(`${process.env.FFB_CRYPTO_TEST_TMP}/key.pem`),
      cert: readFileSync(`${process.env.FFB_CRYPTO_TEST_TMP}/cert.pem`),
    },
    (_req, res) => res.end(readFileSync(`${process.env.FFB_CRYPTO_TEST_TMP}/tone.wav`)),
  );
  await new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', resolve);
  });
  const port = srv.address().port;
  r = await command([
    '-hide_banner',
    '-tls_verify',
    '1',
    '-ca_file',
    `${process.env.FFB_CRYPTO_TEST_TMP}/cert.pem`,
    '-i',
    `https://localhost:${port}/tone.wav`,
    '-f',
    'null',
    '-',
  ]);
  assert.equal(r.status, 0, r.output);
  r = await command([
    '-hide_banner',
    '-tls_verify',
    '1',
    '-ca_file',
    `${process.env.FFB_CRYPTO_TEST_TMP}/wrong-cert.pem`,
    '-i',
    `https://localhost:${port}/tone.wav`,
    '-f',
    'null',
    '-',
  ]);
  assert.notEqual(r.status, 0, 'Untrusted TLS certificate was accepted');
  srv.close();
  console.log('HTTPS: trusted certificate decoded; untrusted certificate rejected');
}
let c1;
const tcp = tcpServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length >= RTMP_HANDSHAKE_SIZE) {
      c1 = buf;
      sock.end(Buffer.alloc(RTMP_HANDSHAKE_SIZE));
    }
  });
});
await new Promise((resolve) => {
  tcp.listen(0, '127.0.0.1', resolve);
});
r = await command([
  '-hide_banner',
  '-loglevel',
  'debug',
  '-i',
  `rtmpe://127.0.0.1:${tcp.address().port}/live/test`,
  '-f',
  'null',
  '-',
]);
tcp.close();
assert(c1 && c1.length >= RTMP_HANDSHAKE_SIZE, 'No RTMPE client handshake');
assert.equal(c1[0], RTMP_ENCRYPTED_VERSION, 'Expected encrypted RTMP handshake');
assert.notEqual(r.status, 0, 'Dummy server should not complete a session');
console.log(
  'RTMPE: encrypted client handshake sent to a local dummy server (not a complete stream test)',
);
