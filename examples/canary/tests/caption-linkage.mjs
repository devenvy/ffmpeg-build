import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.env.FFMPEG;
assert.ok(ffmpeg);
const fixtures = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'ffb-captions-'));
const TIMEOUT = 30000;
const command = (program, args) => {
  const result = spawnSync(program, args, { timeout: TIMEOUT });
  assert.equal(
    result.status,
    0,
    `${program}: ${result.error?.message ?? result.stderr?.toString()}`,
  );
  assert.equal(result.signal, null);
  return result.stdout.toString();
};
try {
  for (const fixture of JSON.parse(readFileSync(join(fixtures, 'caption-fixtures.json'), 'utf8'))) {
    const bytes = Buffer.from(
      readFileSync(join(fixtures, `${fixture.name}.base64`), 'utf8'),
      'base64',
    );
    assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sha);
    writeFileSync(join(work, `${fixture.name}.ts`), bytes);
  }
  for (const { decoder, options, fixture, text } of [
    { decoder: 'libaribb24', options: [], fixture: 'arib.ts', text: 'ＦＦＢ' },
    { decoder: 'libaribcaption', options: ['-sub_type', 'ass'], fixture: 'arib.ts', text: 'FFB' },
    {
      decoder: 'libzvbi_teletextdec',
      options: [
        '-txt_format',
        'text',
        '-txt_page',
        '100',
        '-txt_duration',
        '1000',
        '-fix_teletext_pts',
        '0',
      ],
      fixture: 'teletext.ts',
      text: 'FFB authored Teletext',
    },
  ]) {
    const output = command(ffmpeg, [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-c:s',
      decoder,
      ...options,
      '-i',
      join(work, fixture),
      '-map',
      '0:s:0',
      '-c:s',
      'srt',
      '-f',
      'srt',
      '-',
    ]);
    assert.ok(output.includes(text), `${decoder}: authored caption text`);
    assert.match(output, /00:00:0[01],000 -->/u, `${decoder}: actual timestamped subtitle`);
    console.log(`${decoder}: authored MPEG-TS decoded caption text and timestamps passed`);
  }
  const devices = command(ffmpeg, ['-hide_banner', '-devices']);
  assert.match(devices, /decklink/u);
  const libraryFolder = dirname(ffmpeg);
  const installed = readdirSync(libraryFolder);
  const dependencies = (prefix) => {
    const library = installed.find((name) => name.startsWith(`${prefix}.so.`));
    assert.ok(library, prefix);
    return command('readelf', ['-d', join(libraryFolder, library)]);
  };
  const codecDependencies = dependencies('libavcodec');
  const deviceDependencies = dependencies('libavdevice');
  for (const [name, parent] of [
    ['libaribb24.so.0', codecDependencies],
    ['libaribcaption.so', codecDependencies],
    ['libzvbi.so.0', codecDependencies],
    ['libklvanc.so.0', deviceDependencies],
  ]) {
    assert.equal(
      parent.includes(`[${name}]`),
      installed.includes(name),
      `${name}: selected ELF linkage`,
    );
  }
  for (const name of readdirSync(libraryFolder).filter((entry) =>
    /^lib(?:aribb24|aribcaption|zvbi|klvanc)\.so(?:\.|$)/u.test(entry),
  )) {
    const library = join(libraryFolder, name);
    const dynamic = command('readelf', ['-d', library]);
    assert.match(dynamic, /SONAME/u, name);
    assert.doesNotMatch(dynamic, /libstdc\+\+\.so/u, name);
    if (name.startsWith('libaribcaption')) {
      const exported = command('nm', ['-D', '--defined-only', library]);
      assert.doesNotMatch(
        exported,
        /\b(?:FT_|Fc[A-Z]|XML_|png_|inflate|deflate|crc32|adler32)/u,
        name,
      );
      assert.match(exported, /aribcc_decoder_decode/u);
    }
    console.log(`${name}: SONAME and runtime closure checked`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
