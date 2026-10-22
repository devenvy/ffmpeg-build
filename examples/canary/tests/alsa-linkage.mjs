import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const TIMEOUT = 30000;
const RATE = 48000;
const DURATION = 0.1;
const SAMPLE_BYTES = 2;
const work = mkdtempSync(join(tmpdir(), 'ffb-alsa-linkage-'));
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const shared = existsSync(join(dirname(ffmpeg), 'libasound.so.2'));
const config = join(work, 'alsa.conf');
const marker = join(work, 'plugin-loaded');
const plugin = join(work, 'external.so');
const run = (args) =>
  spawnSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
    env: { ...process.env, ALSA_CONFIG_PATH: config, FFB_ALSA_PLUGIN_MARKER: marker },
    timeout: TIMEOUT,
    maxBuffer: RATE * SAMPLE_BYTES,
  });
try {
  writeFileSync(
    config,
    `pcm.null { type null }
pcm.plugnull { type plug slave.pcm null }
pcm_type.ffb_external { lib "${plugin}" }
pcm.external { type ffb_external }
`,
  );
  for (const device of ['null', 'plugnull']) {
    const output = run([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      String(DURATION),
      '-f',
      'alsa',
      device,
    ]);
    assert.equal(output.status, 0, output.stderr?.toString());
    const input = run([
      '-f',
      'alsa',
      '-sample_rate',
      String(RATE),
      '-ch_layout',
      'mono',
      '-i',
      device,
      '-af',
      'asetpts=N/SR/TB',
      '-t',
      String(DURATION),
      '-f',
      's16le',
      '-',
    ]);
    assert.equal(input.status, 0, input.stderr?.toString());
    assert.equal(input.stdout.length, RATE * DURATION * SAMPLE_BYTES);
  }
  const alsoft = join(work, 'alsoft.conf');
  writeFileSync(alsoft, '[alsa]\ncapture = null\n');
  const captured = spawnSync(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'openal',
      '-sample_rate',
      String(RATE),
      '-channels',
      '1',
      '-i',
      '',
      '-af',
      'asetpts=N/SR/TB',
      '-t',
      String(DURATION),
      '-f',
      's16le',
      '-',
    ],
    {
      env: {
        ...process.env,
        ALSA_CONFIG_PATH: config,
        ALSOFT_CONF: alsoft,
        ALSOFT_DRIVERS: 'alsa',
      },
      timeout: TIMEOUT,
      maxBuffer: RATE * SAMPLE_BYTES,
    },
  );
  assert.equal(captured.status, 0, captured.stderr?.toString());
  assert.equal(captured.stdout.length, RATE * DURATION * SAMPLE_BYTES);
  const c = join(work, 'plugin.c');
  writeFileSync(
    c,
    `#include <stdio.h>
#include <stdlib.h>
__attribute__((constructor)) static void loaded(void) {
  const char *path = getenv("FFB_ALSA_PLUGIN_MARKER");
  if (path) { FILE *f = fopen(path, "w"); if (f) { fputs("loaded", f); fclose(f); } }
}
`,
  );
  const compiled = spawnSync('cc', ['-shared', '-fPIC', c, '-o', plugin], { timeout: TIMEOUT });
  assert.equal(compiled.status, 0, compiled.stderr?.toString());
  const external = run([
    '-f',
    'lavfi',
    '-i',
    'anullsrc',
    '-t',
    String(DURATION),
    '-f',
    'alsa',
    'external',
  ]);
  assert.notEqual(external.status, 0, 'the controlled plugin has no ALSA entrypoint');
  if (shared) {
    assert.equal(
      readFileSync(marker, 'utf8'),
      'loaded',
      'shared mode must load the selected external plugin',
    );
  } else {
    assert.equal(existsSync(marker), false, 'static mode must never load an external plugin');
    assert.match(
      external.stderr.toString(),
      /External plugins are disabled in this static ALSA build/,
    );
  }
  const libraries = readdirSync(dirname(ffmpeg)).filter((name) => name.includes('.so'));
  const dependencies = spawnSync(
    'readelf',
    ['-d', ffmpeg, ...libraries.map((name) => join(dirname(ffmpeg), name))],
    {
      encoding: 'utf8',
      timeout: TIMEOUT,
    },
  );
  assert.equal(dependencies.status, 0, dependencies.stderr);
  assert.equal(/NEEDED.*libasound\.so/.test(dependencies.stdout), shared);
  console.log(
    `ALSA ${shared ? 'shared' : 'static'}: builtin capture/playback, OpenAL capture and external-plugin ownership passed`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
