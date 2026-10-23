import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const TIMEOUT = 60000;
const START_DELAY = 500;
const PORT_BASE = 24000;
const PID_RANGE = 1000;
const WIDTH = 128;
const HEIGHT = 96;
const CHANNELS = 3;
const BLUE_CHANNEL = 2;
const FRAMES = 8;
const RED_MIN = 240;
const OTHER_MAX = 10;
const SECRET = 'ffb-own-stream-secret';
const FLAGS = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
const active = new Set();
const prefix = process.env.FFB_NETWORK_CONTAINER
  ? ['docker', 'exec', '-e', 'LD_BIND_NOW=1', process.env.FFB_NETWORK_CONTAINER, '/ffmpeg/ffmpeg']
  : [ffmpeg];
const processRun = (args, timeout = TIMEOUT) => {
  const child = spawn(prefix[0], [...prefix.slice(1), ...FLAGS, ...args], { timeout });
  active.add(child);
  const output = [];
  const errors = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => errors.push(chunk));
  const result = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => {
      active.delete(child);
      resolve({
        status,
        signal,
        output: Buffer.concat(output),
        error: Buffer.concat(errors).toString(),
      });
    });
  });
  result.catch(() => {
    // Both peers are awaited below after the sender has started.
  });
  return result;
};
const sender = [
  '-re',
  '-f',
  'lavfi',
  '-i',
  `color=red:s=${WIDTH}x${HEIGHT}:r=10:d=3`,
  '-c:v',
  'mpeg2video',
  '-g',
  '1',
  '-bf',
  '0',
  '-f',
  'mpegts',
];
const receiver = [
  '-rw_timeout',
  '4000000',
  '-probesize',
  '2048',
  '-analyzeduration',
  '0',
  '-f',
  'mpegts',
];
const transport = async (name, encrypted, wrong) => {
  const port = PORT_BASE + (process.pid % PID_RANGE);
  const receiverOptions = [];
  const senderOptions = [];
  let input;
  let output;
  if (name === 'srt') {
    const crypto = encrypted ? `&pbkeylen=16&enforced_encryption=1&passphrase=${SECRET}` : '';
    input = `srt://127.0.0.1:${port}?mode=listener&listen_timeout=5000000&timeout=5000000${crypto}`;
    output = `srt://127.0.0.1:${port}?mode=caller&timeout=3000000${wrong ? crypto.replace(SECRET, 'ffb-wrong-stream-secret') : crypto}`;
  } else {
    input = `rist://@127.0.0.1:${port}`;
    output = `rist://127.0.0.1:${port}`;
    if (encrypted) {
      receiverOptions.push('-secret', SECRET, '-encryption', '128');
      senderOptions.push(
        '-secret',
        wrong ? 'ffb-wrong-stream-secret' : SECRET,
        '-encryption',
        '128',
      );
    }
  }
  const capture = processRun([
    ...receiver,
    ...receiverOptions,
    '-i',
    input,
    '-frames:v',
    String(FRAMES),
    '-map',
    '0:v:0',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ]);
  await setTimeout(START_DELAY);
  const transmit = processRun([...sender, ...senderOptions, output]);
  const [received, sent] = await Promise.all([capture, transmit]);
  if (wrong) {
    assert.equal(received.output.length, 0, 'A wrong secret must deliver no media');
    assert.notEqual(received.status, 0);
    assert.equal(received.signal, null, received.error);
    console.log(`${name}: wrong-secret rejection passed`);
    return;
  }
  assert.equal(
    received.status,
    0,
    `${name}: receiver signal=${received.signal}, ${received.error}; sender status=${sent.status}, signal=${sent.signal}, ${sent.error}`,
  );
  assert.equal(received.signal, null, received.error);
  assert.equal(received.output.length, WIDTH * HEIGHT * CHANNELS * FRAMES);
  for (let pixel = 0; pixel < received.output.length; pixel += CHANNELS) {
    assert.ok(received.output[pixel] >= RED_MIN);
    assert.ok(received.output[pixel + 1] <= OTHER_MAX);
    assert.ok(received.output[pixel + BLUE_CHANNEL] <= OTHER_MAX);
  }
  console.log(
    `${name} ${encrypted ? 'encrypted' : 'clear'}: all ${FRAMES} authored red frames passed`,
  );
};
try {
  const protocols = process.env.FFB_TRANSPORT_PROTOCOLS?.split(',') ?? ['srt', 'rist'];
  assert.ok(protocols.length && protocols.every((protocol) => ['srt', 'rist'].includes(protocol)));
  for (const protocol of protocols) {
    await transport(protocol, false, false);
    if (process.env.FFB_CRYPTO !== 'off') {
      await transport(protocol, true, false);
      await transport(protocol, true, true);
    }
  }
} finally {
  for (const child of active) {
    child.kill('SIGTERM');
  }
}
export { processRun, sender, receiver };
