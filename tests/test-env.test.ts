import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { tarGz } from './github-fake.ts';
import { fixtureData, fixtureEngineRoot, runCli } from './helpers.ts';
import {
  maskCommand,
  parseTestEnv,
  scriptEnv,
  takeTestEnv,
  targetTestEnv,
  TEST_ENV_VARIABLE,
} from '../src/commands/test-env.ts';
import { dockerArgs, runTest } from '../src/commands/test.ts';
import { formatFolderLock } from '../src/lockfile.ts';
import { loadFolder } from '../src/targets.ts';

const data = fixtureData();
const LOCK = { engine: '0.2.0', ffmpeg: { '9': '9.1.0' }, libraries: { dav1d: '1.5.4' } };

/** A folder with one target "built" into dist, its ffmpeg a script that answers like the real one. */
function built(target: string, tests: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'ffmpeg-build-test-env-'));
  writeFileSync(join(d, 'ffmpeg-build.yml'), `targets:\n  t: ${target}\n`);
  writeFileSync(join(d, 'ffmpeg.lock'), formatFolderLock(LOCK));
  for (const [path, text] of Object.entries(tests)) {
    mkdirSync(join(d, path, '..'), { recursive: true });
    writeFileSync(join(d, path), text);
  }
  const ffmpeg = [
    '#!/usr/bin/env bash',
    'case "$*" in',
    '  *-version*) echo "ffmpeg version 9.1.0 Copyright" ;;',
    '  *-buildconf*) echo "  --disable-gpl --enable-version3 --disable-nonfree --enable-shared" ;;',
    'esac',
  ].join('\n');
  mkdirSync(join(d, 'dist'));
  writeFileSync(
    join(d, 'dist', 'ffmpeg-9.1.0-t.tar.gz'),
    tarGz([{ name: 'ffmpeg', data: `${ffmpeg}\n`, mode: 0o755 }]),
  );
  return d;
}
const folderOf = (d: string) => {
  const r = loadFolder(d);
  if (!r.ok) {
    throw new Error(r.errors.join('\n'));
  }
  return r.folder;
};

describe('test-env: secrets for a target’s test scripts', () => {
  it('reads NAME=value lines: CRLF, comments and blank lines, the value verbatim after the first =', () => {
    expect([
      ...parseTestEnv('# keys\r\nDECRYPT_KEY=a=b c\r\n\r\n  \nTOKEN=\nlower_ok=x\n').entries(),
    ]).toEqual([
      ['DECRYPT_KEY', 'a=b c'],
      ['TOKEN', ''],
      ['lower_ok', 'x'],
    ]);
  });

  it('refuses a malformed line by its number, never echoing it; and duplicates, reserved names and NUL', () => {
    expect(() => parseTestEnv('A=1\nsup3r-s3cret\n')).toThrow(/line 2: expected NAME=value/);
    expect(() => parseTestEnv('1BAD=sup3r-s3cret')).toThrow(/^(?!.*sup3r-s3cret).*line 1/s);
    expect(() => parseTestEnv('A=1\nA=2')).toThrow('line 2: A is given twice');
    expect(() => parseTestEnv('FFMPEG=/x')).toThrow('FFMPEG is set by ffmpeg-build test itself');
    expect(() => parseTestEnv('A=x\0y')).toThrow("A's value has a NUL character");
  });

  it('takes the secret out of the environment and masks each value on GitHub Actions only', () => {
    const printed: string[] = [];
    const env: NodeJS.ProcessEnv = {
      [TEST_ENV_VARIABLE]: 'KEY=50%\nEMPTY=\nOTHER=two',
      GITHUB_ACTIONS: 'true',
    };
    const values = takeTestEnv(env, (l) => {
      printed.push(l);
    });
    expect(env[TEST_ENV_VARIABLE]).toBeUndefined();
    expect(values.get('KEY')).toBe('50%');
    expect(printed).toEqual(['::add-mask::50%25', '::add-mask::two']);
    expect(maskCommand('a\r\nb')).toBe('::add-mask::a%0D%0Ab');
    const local: string[] = [];
    takeTestEnv({ [TEST_ENV_VARIABLE]: 'KEY=v' }, (l) => {
      local.push(l);
    });
    expect(local).toEqual([]);
    expect(takeTestEnv({}, () => undefined).size).toBe(0);
  });

  it('gives a target only the names it lists: from the secret, else the environment; empty is missing', () => {
    const secret = new Map([
      ['KEY', 'k'],
      ['FORK', ''],
      ['NOT_LISTED', 'n'],
    ]);
    const printed: string[] = [];
    expect(
      targetTestEnv(
        ['KEY', 'FORK', 'LOCAL', 'NONE'],
        secret,
        { LOCAL: 'l', FORK: 'ambient', GITHUB_ACTIONS: 'true' },
        (l) => {
          printed.push(l);
        },
      ),
    ).toEqual({ vars: { KEY: 'k', LOCAL: 'l' }, missing: ['FORK', 'NONE'] });
    // a value from the environment is masked too
    expect(printed).toEqual(['::add-mask::l']);
    // a native script's environment: the secret's other names gone (in any case on Windows), the target's set
    expect(
      scriptEnv({ PATH: '/bin', NOT_LISTED: 'x', key: 'old' }, secret, { KEY: 'k' }, 'linux'),
    ).toEqual({ PATH: '/bin', key: 'old', KEY: 'k' });
    expect(
      scriptEnv({ Path: 'C:\\', not_listed: 'x', Key: 'old' }, secret, { KEY: 'k' }, 'win32'),
    ).toEqual({
      Path: 'C:\\',
      KEY: 'k',
    });
  });

  it('passes a container a variable by name: the value stays off docker’s command line', () => {
    expect(
      dockerArgs('i', ['/b'], '/b', { FFMPEG: '/b/ffmpeg' }, 'bash', ['t.sh'], false, undefined, [
        'KEY',
      ]),
    ).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      '/b:/b:ro',
      '-w',
      '/b',
      '-e',
      'FFMPEG=/b/ffmpeg',
      '-e',
      'KEY',
      'i',
      'bash',
      't.sh',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'runs a native script with its listed variables and none of the others, and says which it lacks',
    async () => {
      const d = built(
        '{ platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d], tests: [tests/key.sh], test-env: [KEY, FORK] }',
        {
          'tests/key.sh': [
            '[ "$KEY" = "s3cret" ] || { echo "KEY wrong"; exit 1; }',
            '[ -z "$OTHER" ] || { echo "OTHER leaked"; exit 1; }',
            `[ -z "$${TEST_ENV_VARIABLE}" ] || { echo "the secret leaked"; exit 1; }`,
            '[ -z "$FORK" ] || { echo "FORK set"; exit 1; }',
            '',
          ].join('\n'),
        },
      );
      const r = await runTest(folderOf(d), data, {
        target: 't',
        dist: join(d, 'dist'),
        runnable: ['linux-x64'],
        testEnv: new Map([
          ['KEY', 's3cret'],
          ['OTHER', 'o'],
          ['FORK', ''],
        ]),
        env: { OTHER: 'o' },
      });
      expect(r.output).toContain('✓ tests: tests/key.sh');
      expect(r.output).toContain(
        "- test-env: FORK not set, so the tests run without it (a run without the secret, like a pull request from a fork's, has none)",
      );
      expect(r.exitCode).toBe(0);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'runs a container script with -e NAME, the value in docker’s own environment',
    async () => {
      const d = built(
        '{ platform: linux-musl-x64, license: lgplv3, ffmpeg: 9, with: [dav1d], tests: [tests/key.sh], test-env: [KEY] }',
        {
          'tests/key.sh': 'exit 0\n',
        },
      );
      // a docker that records how it was called, and passes everything
      const bin = join(d, 'bin');
      mkdirSync(bin);
      const log = join(d, 'docker.log');
      writeFileSync(
        join(bin, 'docker'),
        `#!/usr/bin/env bash\necho "$* | KEY=\${KEY:-}" >> '${log}'\necho "ffmpeg version 9.1.0"\n`,
      );
      chmodSync(join(bin, 'docker'), 0o755);
      await runTest(folderOf(d), data, {
        target: 't',
        dist: join(d, 'dist'),
        runnable: ['linux-x64'],
        docker: true,
        testEnv: new Map([['KEY', 's3cret']]),
        env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      });
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      const script = calls.find((c) => c.includes('key.sh'))!;
      expect(script).toContain('-e KEY ');
      expect(script).toMatch(/\| KEY=s3cret$/);
      expect(script.split(' | ')[0]).not.toContain('s3cret');
      // the smoke test's ffmpeg gets nothing of it
      expect(calls.filter((c) => !c.includes('key.sh')).every((c) => c.endsWith('| KEY='))).toBe(
        true,
      );
    },
  );

  it('check refuses a test-env name the engine sets itself', () => {
    const d = built(
      '{ platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d], test-env: [FFMPEG] }',
      {},
    );
    const r = runCli(['check'], { cwd: d, env: { FFMPEG_BUILD_DATA: fixtureEngineRoot } });
    expect(r.exitCode).toBe(2);
    expect(r.out + r.err).toContain('FFMPEG is set by ffmpeg-build test itself');
  });

  it('`ffmpeg-build test` refuses a malformed secret without showing it', () => {
    const d = built('{ platform: linux-x64, license: lgplv3, ffmpeg: 9, with: [dav1d] }', {});
    const r = runCli(['test', '--target', 't', '--dist', join(d, 'dist')], {
      cwd: d,
      env: { FFMPEG_BUILD_DATA: fixtureEngineRoot, [TEST_ENV_VARIABLE]: 'not-a-pair-s3cret' },
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.out + r.err).toContain('line 1: expected NAME=value');
    expect(r.out + r.err).not.toContain('s3cret');
  });
});
