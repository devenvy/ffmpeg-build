import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { copyStudio, copyStudioFolder, fixtureEngineRoot, runCli } from './helpers.ts';
import { packageVersion } from '../src/paths.ts';

describe('ffmpeg-build', () => {
  it('prints its version', () => {
    expect(runCli(['--version']).stdout.trim()).toBe(packageVersion());
  });
});

const env = { FFMPEG_BUILD_DATA: fixtureEngineRoot };
const studio = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-studio-'));
  copyStudioFolder(dir);
  return dir;
};
// two targets with problems: an option nobody has heard of, and a pin on something FFmpeg builds itself
const BAD =
  'pin: { schannel: "1.0" }\ntargets:\n  t: { platform: linux-x64, license: gplv3, ffmpeg: 9, with: [frobnicate, dav1d] }\n';
const bad = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-bad-'));
  writeFileSync(join(dir, 'ffmpeg-build.yml'), BAD);
  return dir;
};

describe('ffmpeg-build check', () => {
  it('passes good targets with exit code 0', () => {
    const r = runCli(['check'], { cwd: studio(), env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('target linux-x64 (linux-x64, nonfree, FFmpeg 9)');
    expect(r.stdout).toContain('with: nvenc');
  });

  it('exits 1 and lists the problems', () => {
    const r = runCli(['check'], { cwd: bad(), env });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain(
      'pin schannel: schannel is part of FFmpeg itself; there is no library version to pin.',
    );
    expect(r.stdout).toContain('ffmpeg-build doesn\'t know "frobnicate"');
  });

  it('exits 2 and says how to start when there is no ffmpeg-build.yml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-empty-'));
    writeFileSync(join(dir, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx\n'); // not a profile
    mkdirSync(join(dir, 'old.yml')); // a folder named like a profile isn't one either
    const r = runCli(['check'], { cwd: dir, env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('no ffmpeg-build.yml here: start one with `ffmpeg-build init`');
  });

  it('exits 2 when the engine data itself is broken', () => {
    const r = runCli(['check'], {
      cwd: studio(),
      env: { FFMPEG_BUILD_DATA: mkdtempSync(join(tmpdir(), 'ffmpeg-build-nodata-')) },
    });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('is FFMPEG_BUILD_DATA right?');
    expect(r.stdout).not.toContain('    at ');
  });
});

describe('a folder of old matrix profiles', () => {
  it("doesn't take other YAML for one: a platforms.yml, or a compose file with a name", () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-not-old-'));
    writeFileSync(
      join(dir, 'platforms.yml'),
      'platforms:\n  linux-x64: { image: linux-x64, setup: linux }\n',
    );
    writeFileSync(join(dir, 'compose.yml'), 'name: media\nservices:\n  web:\n    image: nginx\n');
    const r = runCli(['check'], { cwd: dir, env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain('no ffmpeg-build.yml here: start one with `ffmpeg-build init`');
  });

  it('every command points at migrate, and changes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-old-'));
    copyStudio(dir);
    const before = readFileSync(join(dir, 'studio.yml'), 'utf8');
    for (const args of [
      ['check'],
      ['plan'],
      ['lock'],
      ['update'],
      ['outdated'],
      ['targets'],
      ['show', 'x'],
      ['build', '--target', 'x'],
      ['profile', 'add', 'x265', '--to', 'x'],
      ['profile', 'missing'],
    ]) {
      const r = runCli(args, { cwd: dir, env });
      expect(r.exitCode, args.join(' ')).toBe(2);
      expect(r.stdout, args.join(' ')).toContain(
        'studio.yml is an old matrix profile: ffmpeg-build now reads ffmpeg-build.yml, one target per build. Run `ffmpeg-build migrate` here to convert',
      );
    }
    expect(readFileSync(join(dir, 'studio.yml'), 'utf8')).toBe(before);
  });
});

describe('ffmpeg-build usage errors', () => {
  it('exits 2 for an unknown option or command, so scripts can tell them from target problems', () => {
    expect(runCli(['check', '--bogus'], { env }).exitCode).toBe(2);
    expect(runCli(['frobnicate'], { env }).exitCode).toBe(2);
    expect(runCli(['check', 'studio.yml'], { cwd: studio(), env }).exitCode).toBe(2); // profile files are no longer arguments
  });

  it('still exits 0 for --help', () => {
    expect(runCli(['--help']).exitCode).toBe(0);
  });

  it('with --json, a usage error is {"error", "problems"} on stdout, exit 2, nothing on stderr', () => {
    for (const args of [
      ['check', '--json', '--bogus'],
      ['profile', 'add', '--json'],
      ['frobnicate', '--json'],
    ]) {
      const r = runCli(args, { cwd: studio(), env });
      expect(r.exitCode, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toBe('');
      const parsed = JSON.parse(r.out) as { error: string; problems: unknown[] };
      expect(parsed.problems).toEqual([]);
      expect(parsed.error).not.toBe('');
    }
    expect(
      (JSON.parse(runCli(['check', '--json', '--bogus'], { env }).out) as { error: string }).error,
    ).toContain('--bogus');
  });

  it('without --json, a usage error is one line on stderr, exit 2, nothing on stdout', () => {
    for (const args of [['check', '--bogus'], ['profile', 'add'], ['frobnicate'], ['chek']]) {
      const r = runCli(args, { cwd: studio(), env });
      expect(r.exitCode, args.join(' ')).toBe(2);
      expect(r.out, args.join(' ')).toBe('');
      expect(r.err.trim().split('\n'), args.join(' ')).toHaveLength(1);
    }
    expect(runCli(['check', '--bogus'], { env }).err).toContain('--bogus');
  });

  it('--help and --version still print to stdout and exit 0, also for a subcommand', () => {
    for (const args of [['--help'], ['check', '--help'], ['help', 'check'], ['--version']]) {
      const r = runCli(args, { env });
      expect(r.exitCode, args.join(' ')).toBe(0);
      expect(r.out.trim(), args.join(' ')).not.toBe('');
    }
    expect(runCli(['check', '--help'], { env }).out).toContain('--json');
  });
});

describe('ffmpeg-build plan', () => {
  it('shows each target with its options, libraries and pins', () => {
    const r = runCli(['plan'], { cwd: studio(), env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('  FFmpeg 9 (9.1.0) · nonfree');
    expect(r.stdout).toContain(
      '    linux-arm64\n      options:   dav1d, nvenc, opus, srt, vaapi\n      libraries: dav1d, libdrm, libva, nv-codec, opus, mbedtls, srt\n      pinned:    nv-codec 13.0',
    );
  });

  it('prints JSON with --json', () => {
    const plans = JSON.parse(runCli(['plan', '--json'], { cwd: studio(), env }).stdout) as {
      target: string;
      builds: { platform: string; libraries: string[]; pinned: Record<string, string> }[];
    }[];
    expect(plans.map((p) => p.target)).toEqual(['linux-x64', 'linux-arm64']);
    expect(plans[0]!.builds[0]!.libraries).toEqual([
      'dav1d',
      'libdrm',
      'libva',
      'nv-codec',
      'opus',
      'mbedtls',
      'srt',
    ]);
    expect(plans[0]!.builds[0]!.pinned).toEqual({ 'nv-codec': '13.0' });
  });

  it('keeps --json output JSON when a target fails check, and refuses to plan it', () => {
    const r = runCli(['plan', '--json'], { cwd: bad(), env });
    expect(r.exitCode).toBe(1);
    const body = JSON.parse(r.stdout) as { error: string; problems: string[] };
    expect(Array.isArray(body)).toBe(false);
    expect(body.error).toMatch(/problem/);
    expect(body.problems).toContain(
      't: with: frobnicate: ffmpeg-build doesn\'t know "frobnicate". Use the name FFmpeg gives it, like nvenc, x265 or whisper.',
    );
    expect(runCli(['plan'], { cwd: bad(), env }).exitCode).toBe(1);
  });
});

describe('ffmpeg-build profile (editing ffmpeg-build.yml)', () => {
  it('add --to a base reaches every target using it, keeps comments, and shows check', () => {
    const dir = studio();
    const r = runCli(['profile', 'add', 'x265', '--to', 'streaming'], { cwd: dir, env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('added x265 to streaming (reaches linux-x64, linux-arm64)');
    expect(r.stdout).toContain('target linux-arm64 (linux-arm64, nonfree, FFmpeg 9)');
    const text = readFileSync(join(dir, 'ffmpeg-build.yml'), 'utf8');
    expect(text).toContain('# Studio: ingest');
    expect(text).toContain('streaming: { with: [nvenc, vaapi, srt, dav1d, opus, x265] }');
  });

  it('add needs --to, and refuses a name it does not know, without touching the file', () => {
    const dir = studio();
    const before = readFileSync(join(dir, 'ffmpeg-build.yml'), 'utf8');
    const where = runCli(['profile', 'add', 'x265'], { cwd: dir, env });
    expect(where.exitCode).toBe(2);
    expect(where.stdout).toContain('say where to add: --to <base or target> (bases: streaming;');
    const unknown = runCli(['profile', 'add', 'frobnicate', '--to', 'streaming'], {
      cwd: dir,
      env,
    });
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stdout).toContain('ffmpeg-build doesn\'t know "frobnicate"');
    expect(readFileSync(join(dir, 'ffmpeg-build.yml'), 'utf8')).toBe(before);
  });

  it('says when an edit changes nothing, and when a target keeps turning down what its base now gives', () => {
    const dir = studio();
    const none = runCli(['profile', 'remove', 'x265', '--from', 'streaming'], { cwd: dir, env });
    expect(none.exitCode).toBe(0);
    expect(none.stdout).toBe("nothing changed: streaming doesn't have x265\n");
    runCli(['profile', 'remove', 'opus', '--from', 'linux-arm64'], { cwd: dir, env });
    runCli(['profile', 'remove', 'opus', '--from', 'streaming'], { cwd: dir, env });
    const r = runCli(['profile', 'add', 'opus', '--to', 'streaming'], { cwd: dir, env });
    expect(r.stdout).toContain('  opus stays out of linux-arm64: it turns it down (without:)');
  });

  it('remove --from a target turns down what its base gives it', () => {
    const dir = studio();
    const r = runCli(['profile', 'remove', 'opus', '--from', 'linux-arm64'], { cwd: dir, env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('removed opus from linux-arm64');
    const plans = JSON.parse(runCli(['plan', '--json'], { cwd: dir, env }).stdout) as {
      target: string;
      builds: { options: string[] }[];
    }[];
    expect(plans.find((p) => p.target === 'linux-arm64')!.builds[0]!.options).not.toContain('opus');
    expect(plans.find((p) => p.target === 'linux-x64')!.builds[0]!.options).toContain('opus');
  });

  it('missing lists what targets could add (exit 1), as text or JSON, until each is listed or turned down', () => {
    const dir = studio();
    const missing = runCli(['profile', 'missing'], { cwd: dir, env });
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain('  x265: linux-x64, linux-arm64');
    const r = runCli(['profile', 'missing', '--json', '--target', 'linux-x64'], { cwd: dir, env });
    expect(r.exitCode).toBe(1);
    // exit 1 with --json is {"error", "problems"}, the answer beside them
    const json = JSON.parse(r.stdout) as {
      error: string;
      problems: string[];
      missing: Record<string, string[]>;
    };
    expect(json.error).toMatch(/could be added/);
    expect(json.problems).toContain('x265: linux-x64');
    expect(json.missing['x265']).toEqual(['linux-x64']);
    expect(json.missing['whisper']).toEqual(['linux-x64']);
  });
});

describe('for agents and scripts', () => {
  it('guide prints the usage guide shipped with the package', () => {
    const r = runCli(['guide']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('# Getting started');
    expect(r.stdout).toContain('ffmpeg-build init');
    expect(r.stdout).toContain('ffmpeg-build options --json');
  });

  it('options lists what a target can name, where it builds and which licenses allow it', () => {
    const r = runCli(['options', '--ffmpeg', '9'], { env });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/\n {2}x265 +x265 +gplv2, gplv3, nonfree +every platform\n/);
    expect(r.stdout).toMatch(/\n {2}vaapi +libva +every license +linux-\*\n/);
    expect(r.stdout).not.toMatch(/\n {2}whep /); // FFmpeg always builds it
  });

  it('options --json gives the same facts as data', () => {
    const options = JSON.parse(runCli(['options', '--ffmpeg', '9', '--json'], { env }).stdout) as {
      name: string;
      libraries?: { name: string; spdx: string; platforms: string[] }[];
      licenses: string[];
      platforms: string[];
      since?: string;
    }[];
    const openssl = options.find((o) => o.name === 'openssl')!;
    expect(openssl).toMatchObject({ licenses: ['lgplv3', 'gplv3', 'nonfree'] });
    expect(openssl.libraries).toEqual([
      { name: 'openssl', spdx: 'Apache-2.0', platforms: openssl.platforms },
    ]);
    expect(openssl.platforms).toContain('linux-x64');
    expect(options.find((o) => o.name === 'amf')).toMatchObject({ since: '9.1.0' });
  });

  it('options takes latest and a minor series like everything else', () => {
    expect(runCli(['options', '--ffmpeg', 'latest'], { env }).stdout).toContain('FFmpeg 9:');
    expect(runCli(['options', '--ffmpeg', '9.0'], { env }).stdout).toContain('FFmpeg 9:');
  });

  it('check --json is {"ok": true, "targets"} when every target is possible', () => {
    const r = runCli(['check', '--json'], { cwd: studio(), env });
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout) as {
      ok: boolean;
      error?: string;
      targets: { header: string; problems: number }[];
    };
    expect(body.ok).toBe(true);
    expect(body.error).toBeUndefined();
    expect(body.targets.some((t) => t.header.startsWith('target linux-x64'))).toBe(true);
  });

  it('check --json on failure is {"error", "problems"}, with each target\'s report beside them', () => {
    const r = runCli(['check', '--json'], { cwd: bad(), env });
    expect(r.exitCode).toBe(1);
    const body = JSON.parse(r.stdout) as {
      ok?: boolean;
      error: string;
      problems: string[];
      targets: {
        header: string;
        problems: number;
        blocks: { title?: string; lines: { mark: string; text: string }[] }[];
      }[];
    };
    expect(Array.isArray(body)).toBe(false);
    expect(body.ok).toBeUndefined();
    expect(body.error).toMatch(/problem/);
    expect(body.problems.some((p) => p.startsWith('target t') && p.includes('frobnicate'))).toBe(
      true,
    );
    const t = body.targets.find((x) => x.header.startsWith('target t'))!;
    expect(t.problems).toBe(1);
    const lines = t.blocks.flatMap((b) => b.lines);
    expect(lines.find((l) => l.text.includes('frobnicate'))!.mark).toBe('✗');
  });

  it('outdated --json stays JSON when a target fails check', () => {
    const r = runCli(['outdated', '--json'], { cwd: bad(), env });
    expect(r.exitCode).toBe(1);
    const body = JSON.parse(r.stdout) as { error: string; problems: string[] };
    expect(body.error).toMatch(/check/);
    expect(body.problems.join('\n')).toContain('frobnicate');
  });
});
