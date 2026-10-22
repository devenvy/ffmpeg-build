import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const TIMEOUT = 15000;
const MAX_OUTPUT = 8388608;
const environment = { ...process.env, LD_BIND_NOW: '1' };
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
  return Buffer.concat([result.stdout, result.stderr]).toString();
};
const devices = command(ffmpeg, ['-hide_banner', '-devices']);
for (const device of ['libdc1394', 'iec61883']) {
  assert.match(devices, new RegExp(`^\\s*D\\s+${device}\\s`, 'mu'));
  const result = spawnSync(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      device,
      '-i',
      'auto',
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ],
    { env: environment, timeout: TIMEOUT, maxBuffer: MAX_OUTPUT },
  );
  assert.equal(result.signal, null, `${device}: bounded hardware-free open attempt`);
  assert.notEqual(
    result.status,
    0,
    `${device}: no FireWire controller is available in this canary environment`,
  );
  assert.match(result.stderr.toString(), /camera|device|port|initialize|open|error/iu);
  assert.equal(result.stdout.length, 0);
}

const folder = dirname(ffmpeg);
const installed = readdirSync(folder);
const owner = installed.find((name) => /^libavdevice\.so\.\d+$/u.test(name));
assert.ok(owner);
const dynamic = command('readelf', ['-d', join(folder, owner)]);
const sonames = [
  'libraw1394.so.11',
  'libavc1394.so.0',
  'librom1394.so.0',
  'libiec61883.so.0',
  'libdc1394.so.26',
];
for (const soname of sonames) {
  const bundled = installed.includes(soname);
  assert.equal(
    dynamic.split('\n').some((line) => line.includes('(NEEDED)') && line.includes(`[${soname}]`)),
    bundled,
    `${soname}: selected FFmpeg owner dependency`,
  );
  if (bundled) {
    const library = join(folder, soname);
    const dependencies = command('readelf', ['-d', library]);
    assert.ok(dependencies.includes(`[${soname}]`), `${soname}: native SONAME`);
    assert.doesNotMatch(dependencies, /libstdc\+\+\.so|libusb/iu);
    if (soname !== 'libraw1394.so.11') {
      assert.doesNotMatch(
        command('nm', ['-D', '--defined-only', library]),
        /\braw1394_/u,
        `${soname}: private embedded raw API`,
      );
    }
  }
}
assert.equal(installed.includes('librom1394.so.0'), installed.includes('libavc1394.so.0'));
const configuration = command(ffmpeg, ['-hide_banner', '-buildconf']);
const shared = sonames.some((soname) => installed.includes(soname));
assert.equal(
  [...configuration.matchAll(/--as-needed/gu)].length,
  shared ? 1 : 0,
  'shared compiler-probe flag is deduplicated; static defaults unchanged',
);
command(ffmpeg, [
  '-nostdin',
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=64x64:rate=8:duration=1',
  '-frames:v',
  '8',
  '-f',
  'null',
  '-',
]);
console.log(
  'FireWire: device listing, bounded no-controller failures, exact selected DSO owner/SONAMEs and software smoke passed; hardware capture untested',
);
