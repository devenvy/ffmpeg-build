import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const COMMAND_TIMEOUT = 30000;
const SERVER_TIMEOUT = 300000;
const READY_ATTEMPTS = 120;
const READY_DELAY = 1000;
const PUBLIC_DIRECTORY = 0o755;
const CLIENT =
  'mirror.gcr.io/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587';
const SERVER =
  'mirror.gcr.io/library/ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac';
const name = `ffb-smb-${process.pid}`;
const dir = mkdtempSync(join(tmpdir(), 'ffb-smb-'));
const runtime = join(dir, 'runtime');
const share = 'smb://ffbtest:ffb-test-pass@ffb-smb-server/media';
const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg, 'The target test runner must set FFMPEG');

const command = (program, args, timeout = COMMAND_TIMEOUT) => {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout });
  if (result.status !== 0) {
    throw new Error(`${program} exited ${result.status}: ${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
};
const docker = (args, timeout) => command('docker', args, timeout);
const remote = (args) =>
  docker([
    'run',
    '--rm',
    '--network',
    name,
    '--user',
    '10001:10001',
    '--mount',
    `type=bind,src=${runtime},dst=/ffmpeg,readonly`,
    '--mount',
    `type=bind,src=${dir},dst=/data,readonly`,
    CLIENT,
    '/ffmpeg/ffmpeg',
    '-hide_banner',
    '-nostdin',
    ...args,
  ]);
const rows = (text) => text.split('\n').filter((line) => line.startsWith('0,'));
try {
  chmodSync(dir, PUBLIC_DIRECTORY);
  // The test runner extracts into a private 0700 directory. Copy its runtime
  // so the unprivileged client can traverse it without changing that directory.
  cpSync(dirname(ffmpeg), runtime, { recursive: true, verbatimSymlinks: true });
  chmodSync(runtime, PUBLIC_DIRECTORY);
  command(ffmpeg, [
    '-hide_banner',
    '-nostdin',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=8000:duration=1',
    '-c:a',
    'pcm_s16le',
    join(dir, 'tone.wav'),
  ]);
  writeFileSync(
    join(dir, 'smb.conf'),
    `[global]
server role = standalone server
server min protocol = SMB3
server signing = mandatory
disable netbios = yes
smb ports = 445
logging = stdout
[media]
path = /srv/media
read only = no
guest ok = no
valid users = ffbtest
smb encrypt = required
`,
  );
  docker(['network', 'create', name]);
  docker(
    [
      'run',
      '-d',
      '--name',
      name,
      '--network',
      name,
      '--network-alias',
      'ffb-smb-server',
      '--mount',
      `type=bind,src=${dir},dst=/data,readonly`,
      SERVER,
      'bash',
      '-euc',
      `
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends samba
useradd --no-create-home --shell /usr/sbin/nologin ffbtest
printf '%s\\n%s\\n' ffb-test-pass ffb-test-pass | smbpasswd -a -s ffbtest
mkdir -p /srv/media
cp /data/tone.wav /srv/media/tone.wav
chown -R ffbtest:ffbtest /srv/media
exec smbd --foreground --no-process-group --debug-stdout --configfile=/data/smb.conf
`,
    ],
    SERVER_TIMEOUT,
  );
  let ready = false;
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    const probe = spawnSync(
      'docker',
      ['exec', name, 'bash', '-c', 'echo > /dev/tcp/127.0.0.1/445'],
      { timeout: COMMAND_TIMEOUT, encoding: 'utf8' },
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await setTimeout(READY_DELAY);
  }
  assert.ok(ready, docker(['logs', name]));
  const local = remote(['-i', '/data/tone.wav', '-f', 'framemd5', '-']);
  const downloaded = remote(['-i', `${share}/tone.wav`, '-f', 'framemd5', '-']);
  assert.deepEqual(rows(downloaded), rows(local));
  remote(['-ss', '0.5', '-i', `${share}/tone.wav`, '-f', 'null', '-']);
  remote(['-y', '-i', '/data/tone.wav', '-c:a', 'pcm_s16le', `${share}/uploaded.wav`]);
  const uploaded = remote(['-i', `${share}/uploaded.wav`, '-f', 'framemd5', '-']);
  assert.deepEqual(rows(uploaded), rows(local));
  console.log(
    'Relocated bundled Samba: non-root authenticated SMB3 read, seek, write and readback passed with mandatory signing and encryption',
  );
} finally {
  spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8', timeout: COMMAND_TIMEOUT });
  spawnSync('docker', ['network', 'rm', name], { encoding: 'utf8', timeout: COMMAND_TIMEOUT });
  rmSync(dir, { recursive: true, force: true });
}
