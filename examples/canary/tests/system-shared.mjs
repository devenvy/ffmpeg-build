import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TIMEOUT = 30000;
const INSTALL_TIMEOUT = 300000;
const HANDSHAKE_BYTES = 1537;
const ENCRYPTED_HANDSHAKE = 6;
const PUBLIC_DIRECTORY = 0o755;
const IMAGE =
  'node:24-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0';

async function client() {
  const ffmpeg = '/runtime/ffmpeg';
  for (const library of ['libgcrypt.so.20', 'libgpg-error.so.0']) {
    assert.equal(
      existsSync(join('/runtime', library)),
      false,
      `${library} must be supplied by the distribution`,
    );
  }
  const report = JSON.parse(readFileSync('/runtime/RUNTIME-DEPENDENCIES.json', 'utf8'));
  assert.deepEqual(report.libraries.map((library) => library.name).sort(), [
    'libgcrypt',
    'libgpg-error',
  ]);
  assert.ok(
    report.requirements.some((binary) => binary.needed?.includes('libgcrypt.so.20')),
    'The report must identify the omitted crypto ABI required by FFmpeg',
  );
  assert.ok(
    readFileSync('/runtime/RUNTIME-DEPENDENCIES.txt', 'utf8').includes('apt-get install'),
    'Package installation guidance must accompany the archive',
  );
  const transcode = spawnSync(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'sine=duration=0.1', '-f', 'null', '-'],
    { encoding: 'utf8', timeout: TIMEOUT },
  );
  assert.equal(transcode.status, 0, transcode.stderr);
  let handshake;
  const server = createServer((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= HANDSHAKE_BYTES) {
        handshake = bytes;
        socket.end(Buffer.alloc(HANDSHAKE_BYTES));
      }
    });
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-nostdin',
        '-i',
        `rtmpe://127.0.0.1:${server.address().port}/live/test`,
        '-f',
        'null',
        '-',
      ],
      { timeout: TIMEOUT, stdio: 'ignore' },
    );
    const status = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    assert.ok(
      handshake && handshake.length >= HANDSHAKE_BYTES,
      'The distro crypto library must produce a real client handshake',
    );
    assert.equal(handshake[0], ENCRYPTED_HANDSHAKE);
    assert.notEqual(status, 0, 'The dummy server cannot complete an RTMPE session');
    console.log(
      'Distribution crypto packages: non-root transcode and encrypted RTMP client handshake passed',
    );
  } finally {
    server.close();
  }
}

if (process.argv.includes('--client')) {
  await client();
} else {
  assert.ok(process.env.FFMPEG, 'The target runner must set FFMPEG');
  const work = mkdtempSync(join(tmpdir(), 'ffb-system-shared-'));
  try {
    chmodSync(work, PUBLIC_DIRECTORY);
    const runtime = join(work, 'runtime');
    cpSync(dirname(process.env.FFMPEG), runtime, { recursive: true, verbatimSymlinks: true });
    chmodSync(runtime, PUBLIC_DIRECTORY);
    const test = join(work, 'test.mjs');
    cpSync(fileURLToPath(import.meta.url), test);
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--mount',
        `type=bind,src=${runtime},dst=/runtime,readonly`,
        '--mount',
        `type=bind,src=${test},dst=/test.mjs,readonly`,
        IMAGE,
        'bash',
        '-c',
        'set -euo pipefail; apt-get update -qq; apt-get install -y --no-install-recommends libgcrypt20 libgpg-error0 >/dev/null; exec runuser -u node -- node /test.mjs --client',
      ],
      { encoding: 'utf8', timeout: INSTALL_TIMEOUT },
    );
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    console.log(result.stdout);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
