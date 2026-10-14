// release.yml: the nightly patch release and the releases a person publishes run CI, publish to npm with trusted
// publishing, attach the tarball and SBOM, and move the major tag. Runs its steps' scripts with stand-ins for gh, git
// and node.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { gitBash } from '../src/commands/test.ts';
import { packageRoot } from '../src/paths.ts';

interface Step {
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  if?: string;
}
interface Job {
  needs?: string | string[];
  if?: string;
  uses?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

const file = join(packageRoot, '.github', 'workflows', 'release.yml');
const release = parse(readFileSync(file, 'utf8')) as Workflow;
const job = (name: string): Job => release.jobs[name]!;
const step = (j: string, name: string): Step =>
  job(j).steps!.find((s) => s.name === name || s.id === name)!;
const bash = process.platform === 'win32' ? gitBash() : 'bash';
const hasJq = spawnSync('jq', ['--version']).status === 0;

interface Fake {
  /** what `gh api .../compare/main...<tag>` says */
  compare?: string;
  /** the releases `gh api .../releases` lists */
  releases?: { tag_name: string; prerelease: boolean; draft?: boolean }[];
  /** whether GitHub marks the release a prerelease (`gh release view --json isPrerelease`) */
  marked?: boolean;
  /** whether the major tag's ref exists */
  majorExists?: boolean;
  /** what scripts/release-due.ts prints */
  due?: string;
}

/** Runs a step's script with stand-in gh and node; its exit status, output, step outputs and gh calls. */
function run(s: Step, vars: Record<string, string>, fake: Fake = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-build-release-'));
  const log = join(dir, 'log').replaceAll('\\', '/');
  // --paginate --slurp: one array per page
  writeFileSync(join(dir, 'releases.json'), JSON.stringify([fake.releases ?? []]));
  writeFileSync(
    join(dir, 'gh'),
    [
      '#!/usr/bin/env bash',
      `echo "gh[$GH_TOKEN] $*" >> "${log}"`,
      'case "$1 $2" in',
      `  "api repos/o/r/compare/"*) echo ${fake.compare ?? 'identical'} ;;`,
      '  "api repos/o/r/commits/"*) echo c0ffee ;;',
      `  "api --paginate") cat "${dir.replaceAll('\\', '/')}/releases.json" ;;`,
      `  "release view") echo ${String(fake.marked ?? false)} ;;`,
      `  "api repos/o/r/git/ref/tags/"*) exit ${fake.majorExists === false ? 1 : 0} ;;`,
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(join(dir, 'node'), `#!/usr/bin/env bash\necho "${fake.due ?? ''}"\n`, {
    mode: 0o755,
  });
  const output = join(dir, 'output');
  const r = spawnSync(bash!, ['-e', '-c', s.run!], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_TOKEN: 'job-token',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      ...vars,
      PATH: `${dir}${delimiter}${process.env['PATH'] ?? ''}`,
    },
  });
  const read = (f: string): string => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    outputs: read(output),
    calls: read(log).trim().split('\n').filter(Boolean),
  };
}

describe('release.yml', () => {
  it('runs for a published release, nightly, and by hand with a tag to publish again', () => {
    expect(release.on['release']).toEqual({ types: ['published'] });
    expect(release.on['schedule']).toHaveLength(1);
    expect(release.on['workflow_dispatch']).toHaveProperty('inputs.tag');
    expect(release.permissions).toEqual({ contents: 'read' });
  });

  it('publishes only after CI passed, and cuts the nightly release only then', () => {
    expect(job('ci').uses).toBe('./.github/workflows/ci.yml');
    expect(job('ci').needs).toBe('plan');
    // CI checks the commit that is published: the tag's, also when it is published again by hand
    expect((job('ci') as Job & { with?: Record<string, string> }).with).toEqual({
      ref: `\${{ needs.plan.outputs.ci-ref }}`,
    });
    expect(job('cut').needs).toEqual(['plan', 'ci']);
    expect(job('cut').if).toBe("needs.plan.outputs.cut == 'true'");
    expect(job('cut').permissions).toEqual({ contents: 'write' });
    expect(job('publish').needs).toEqual(['plan', 'ci', 'cut']);
    expect(job('publish').if).toContain("needs.ci.result == 'success'");
  });

  it('attaches the assets and moves the major tag for a release published by hand, when the nightly cut is skipped', () => {
    // GitHub skips a job when any job before it in its needs chain was skipped, unless its if says otherwise: publish
    // follows cut, which only the nightly runs, so what follows publish must say when it runs
    for (const name of ['release-assets', 'major-tag']) {
      expect(job(name).if, name).toContain('!cancelled()');
      expect(job(name).if, name).toContain("needs.publish.result == 'success'");
    }
  });

  it('publishes through npm trusted publishing: OIDC, no token, never with write access to the repository', () => {
    expect(job('publish').permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
      attestations: 'write',
    });
    expect(step('publish', 'Publish (skipped when the version already exists)').run).toContain(
      'npm publish "$TARBALL" --provenance --access public',
    );
    expect(readFileSync(file, 'utf8')).not.toContain('NPM_TOKEN');
    expect(job('release-assets').permissions).toEqual({ contents: 'write' });
    expect(job('release-assets').permissions).not.toHaveProperty('id-token');
  });

  describe.skipIf(!bash)('the release to publish', () => {
    const plan = () => step('plan', 'tag');

    it('takes the published release, or the tag given by hand, when it is on main', () => {
      const r = run(plan(), { RELEASE_TAG: 'v1.2.3' });
      expect(r.status, r.out).toBe(0);
      expect(r.outputs).toBe(
        'tag=v1.2.3\nversion=1.2.3\ncut=false\nprerelease=false\nci-ref=v1.2.3\n',
      );
      expect(run(plan(), { INPUT_TAG: 'v1.3.0-rc.1' }).outputs).toContain('prerelease=true');
      // marked a prerelease on GitHub, whatever its version says
      expect(run(plan(), { INPUT_TAG: 'v1.3.0' }, { marked: true }).outputs).toContain(
        'prerelease=true',
      );
      expect(run(plan(), { RELEASE_TAG: 'v1.3.0', RELEASE_PRERELEASE: 'true' }).outputs).toContain(
        'prerelease=true',
      );
      const off = run(plan(), { RELEASE_TAG: 'v1.2.3' }, { compare: 'diverged' });
      expect(off.status).toBe(1);
      expect(off.out).toContain('::error::v1.2.3 is not on main');
      const bad = run(plan(), { INPUT_TAG: '1.2.3' });
      expect(bad.status).toBe(1);
      expect(bad.out).toContain('is not a release tag like v1.2.0');
    });

    it('cuts the nightly release from main when one is due, and nothing when none is', () => {
      const due = run(plan(), { REF: 'refs/heads/main' }, { due: 'v1.0.4' });
      expect(due.status, due.out).toBe(0);
      // CI checks the run's own commit, which the release then tags
      expect(due.outputs).toBe('tag=v1.0.4\nversion=1.0.4\ncut=true\nprerelease=false\nci-ref=\n');
      const none = run(plan(), { REF: 'refs/heads/main' });
      expect(none.status, none.out).toBe(0);
      expect(none.outputs).toBe('');
      const elsewhere = run(plan(), { REF: 'refs/heads/feature' }, { due: 'v1.0.4' });
      expect(elsewhere.status).toBe(1);
    });

    it('creates the nightly release on the commit CI tested, with generated notes', () => {
      const r = run(step('cut', 'Create the release'), { TAG: 'v1.0.4', SHA: 'abc123' });
      expect(r.status, r.out).toBe(0);
      expect(r.calls).toEqual([
        'gh[job-token] release create v1.0.4 --repo o/r --target abc123 --title v1.0.4 --generate-notes',
      ]);
    });
  });

  describe.skipIf(!bash || !hasJq)('the major tag', () => {
    const move = () => step('major-tag', 'Move the major tag');
    const releases = [
      { tag_name: 'v1.0.9', prerelease: false },
      { tag_name: 'v1.0.10', prerelease: false },
      { tag_name: 'v1.1.0-rc.1', prerelease: true },
      { tag_name: 'v2.0.0', prerelease: false },
      { tag_name: '9.0.2.2', prerelease: false },
      { tag_name: 'v1.4.0', prerelease: false, draft: true },
    ];

    it('moves to the newest release of its major, or is created', () => {
      expect(job('major-tag').if).toBe(
        `\${{ !cancelled() && needs.publish.result == 'success' && needs.plan.outputs.prerelease != 'true' }}`,
      );
      const moved = run(move(), { TAG: 'v1.0.10', VERSION: '1.0.10' }, { releases });
      expect(moved.status, moved.out).toBe(0);
      expect(moved.calls).toContain(
        'gh[job-token] api --method PATCH repos/o/r/git/refs/tags/v1 -f sha=c0ffee -F force=true',
      );
      const created = run(
        move(),
        { TAG: 'v2.0.0', VERSION: '2.0.0' },
        { releases, majorExists: false },
      );
      expect(created.calls).toContain(
        'gh[job-token] api --method POST repos/o/r/git/refs -f ref=refs/tags/v2 -f sha=c0ffee',
      );
    });

    it('stays when a newer release of the same major is out (an older one published again)', () => {
      const r = run(move(), { TAG: 'v1.0.9', VERSION: '1.0.9' }, { releases });
      expect(r.status, r.out).toBe(0);
      expect(r.calls.filter((c) => c.includes('git/refs'))).toEqual([]);
    });
  });
});
