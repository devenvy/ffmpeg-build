import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const TIMEOUT = 120000;
const BUILD_TIMEOUT = 300000;
const HASH_LENGTH = 16;
const READY_ATTEMPTS = 60;
const READY_DELAY = 1000;
const START_DELAY = 500;
const AMQP_READ_TIMEOUT_US = 30000000;
const AMQP_PROCESS_TIMEOUT = 120000;
const RATE = 48000;
const FLOAT_BYTES = 4;
const SECONDS = 3;
const SILENT_SECONDS = 0.2;
const SIGNAL_SECONDS = 1;
const MIN_POWER = 0.001;
const MAX_POWER = 0.003;
const SILENT_POWER = 0.0000000001;
const RGB_CHANNELS = 3;
const BLUE_CHANNEL = 2;
const WIDTH = 128;
const HEIGHT = 96;
const FRAMES = 8;
const RED_MIN = 240;
const OTHER_MAX = 10;
const name = `ffb-transports-${process.pid}-${Date.now()}`;
const command = (program, args, timeout = TIMEOUT) => {
  const result = spawnSync(program, args, { encoding: 'utf8', timeout });
  assert.equal(
    result.status,
    0,
    `${program}: ${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`,
  );
  return result.stdout;
};
const exec = (args) => command('docker', ['exec', name, ...args]);
try {
  const folder = dirname(fileURLToPath(import.meta.url));
  const dockerfile = join(folder, 'network-runtime.Dockerfile');
  const digest = createHash('sha256')
    .update(readFileSync(dockerfile))
    .digest('hex')
    .slice(0, HASH_LENGTH);
  const image = `ffb-transport-runtime:${digest}`;
  command('docker', ['build', '--tag', image, '--file', dockerfile, folder], BUILD_TIMEOUT);
  command('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--cpus',
    '2',
    '-e',
    'RABBITMQ_DEFAULT_USER=ffb',
    '-e',
    'RABBITMQ_DEFAULT_PASS=ffb-owned-test-pass',
    '-e',
    'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2 +A 2',
    '-e',
    'ERL_FLAGS=+S 2:2 +A 2',
    '--mount',
    `type=bind,src=${dirname(ffmpeg)},dst=/ffmpeg,readonly`,
    image,
  ]);
  let ready = false;
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    // Use the broker's account so an early probe cannot create a root-owned
    // Erlang cookie before the server's first startup has finished.
    const result = spawnSync(
      'docker',
      ['exec', '--user', 'rabbitmq', name, 'rabbitmq-diagnostics', '-q', 'check_running'],
      {
        timeout: TIMEOUT,
      },
    );
    if (result.status === 0) {
      ready = true;
      break;
    }
    await setTimeout(READY_DELAY);
  }
  if (!ready) {
    const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: TIMEOUT });
    assert.fail(`The isolated AMQP broker must start:\n${logs.stdout}\n${logs.stderr}`);
  }
  process.env.FFB_NETWORK_CONTAINER = name;
  const { processRun, sender, receiver } = await import('./transport-linkage.mjs');

  const audio = processRun([
    '-re',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=${RATE}:duration=${SECONDS}`,
    '-af',
    "azmq=bind_address='tcp\\://127.0.0.1\\:5555',volume@ffb=0",
    '-ac',
    '1',
    '-f',
    'f32le',
    '-',
  ]);
  await setTimeout(START_DELAY);
  const python = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'zmq-command.py'),
    'utf8',
  );
  assert.match(exec(['python3', '-c', python]), /^0 Success/m);
  const samples = await audio;
  assert.equal(samples.status, 0, samples.error);
  assert.equal(samples.output.length, RATE * SECONDS * FLOAT_BYTES);
  const power = (begin, end) => {
    let energy = 0;
    for (let sample = begin; sample < end; sample++) {
      const value = samples.output.readFloatLE(sample * FLOAT_BYTES);
      assert.ok(Number.isFinite(value));
      energy += value * value;
    }
    return energy / (end - begin);
  };
  assert.ok(power(0, RATE * SILENT_SECONDS) < SILENT_POWER);
  const changedPower = power(RATE * (SECONDS - SIGNAL_SECONDS), RATE * SECONDS);
  assert.ok(changedPower > MIN_POWER && changedPower < MAX_POWER, String(changedPower));
  console.log(
    `ZeroMQ command ACK and actual silent-to-audible sample change passed: ${changedPower}`,
  );

  const routing = `ffb-${process.pid}-${Date.now()}`;
  const address = 'amqp://ffb:ffb-owned-test-pass@127.0.0.1:5672/%2f';
  let stoppedCapture;
  const capture = processRun(
    [
      ...receiver,
      '-rw_timeout',
      String(AMQP_READ_TIMEOUT_US),
      '-routing_key',
      routing,
      '-i',
      address,
      '-map',
      '0:v:0',
      '-frames:v',
      String(FRAMES),
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ],
    AMQP_PROCESS_TIMEOUT,
  );
  capture.then((result) => {
    stoppedCapture = result;
  });
  let subscribed = false;
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    assert.equal(
      stoppedCapture,
      undefined,
      `AMQP receiver exited before subscription: ${stoppedCapture?.error}`,
    );
    if (/^1\s*$/m.test(exec(['rabbitmqctl', '-q', 'list_queues', 'consumers']))) {
      subscribed = true;
      break;
    }
    await setTimeout(READY_DELAY);
  }
  assert.ok(subscribed, 'AMQP consumer must subscribe before publication');
  const transmit = processRun([...sender, '-routing_key', routing, address]);
  const [received, sent] = await Promise.all([capture, transmit]);
  assert.equal(received.status, 0, `${received.error}\n${sent.error}`);
  assert.equal(sent.status, 0, sent.error);
  assert.equal(received.output.length, WIDTH * HEIGHT * RGB_CHANNELS * FRAMES);
  for (let pixel = 0; pixel < received.output.length; pixel += RGB_CHANNELS) {
    assert.ok(received.output[pixel] >= RED_MIN);
    assert.ok(received.output[pixel + 1] <= OTHER_MAX);
    assert.ok(received.output[pixel + BLUE_CHANNEL] <= OTHER_MAX);
  }
  const rejected = await processRun([
    '-connection_timeout',
    '2000000',
    '-i',
    address.replace('ffb-owned-test-pass', 'wrong-test-pass'),
    '-f',
    'null',
    '-',
  ]);
  assert.notEqual(rejected.status, 0);
  assert.equal(rejected.signal, null);
  assert.match(rejected.error, /Error login|ACCESS_REFUSED/i);
  console.log('RabbitMQ own-user media roundtrip and wrong-password rejection passed');

  const files = readdirSync(dirname(ffmpeg));
  const dynamic = files
    .filter((file) => /\.so(?:\.|$)/.test(file))
    .map((file) => exec(['readelf', '-d', `/ffmpeg/${file}`]))
    .join('\n');
  for (const library of ['srt', 'rist', 'zmq', 'rabbitmq']) {
    const expression = new RegExp(`^lib${library}\\.so`);
    assert.equal(
      new RegExp(`NEEDED.*lib${library}\\.so`).test(dynamic),
      files.some((file) => expression.test(file)),
      `${library}: selected linkage`,
    );
  }
  for (const file of files.filter((candidate) => /^lib(?:srt|zmq)\.so/.test(candidate))) {
    assert.doesNotMatch(exec(['readelf', '-d', `/ffmpeg/${file}`]), /NEEDED.*libstdc\+\+/);
    assert.doesNotMatch(
      exec(['nm', '-D', '--defined-only', `/ffmpeg/${file}`]),
      /\b(?:_Z(?:St|N[KVO]?St|T[ISV]St)|__cxa_|_Unwind_)\w+/,
    );
  }
  console.log('Selected transport ELF dependencies and private compiler exports passed');
} finally {
  delete process.env.FFB_NETWORK_CONTAINER;
  spawnSync('docker', ['rm', '-f', name], { timeout: TIMEOUT });
}
