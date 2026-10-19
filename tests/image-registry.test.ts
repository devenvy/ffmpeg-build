// Docker Hub limits anonymous pulls per address, and CI runners share addresses: a full run's builds get 429 Too Many
// Requests. Every image is pulled from a registry without that limit (Docker Hub's own images through mirror.gcr.io).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { BINFMT } from '../src/commands/test.ts';
import { packageRoot } from '../src/paths.ts';

const registryOf = (image: string) => {
  const first = image.split('/')[0]!;
  return image.includes('/') && /[.:]/.test(first) ? first : 'docker.io';
};

const dockerfiles = () =>
  readdirSync(join(packageRoot, 'images')).map((name) => ({
    name,
    text: readFileSync(join(packageRoot, 'images', name, 'Dockerfile'), 'utf8'),
  }));
/** Each ARG's default value, by name. */
const argDefaults = (text: string) =>
  new Map([...text.matchAll(/^ARG\s+(\w+)=(\S+)/gm)].map((m) => [m[1]!, m[2]!]));

describe('images', () => {
  it('come from registries without an anonymous pull limit', () => {
    const images = readdirSync(join(packageRoot, 'images')).flatMap((name) =>
      [
        ...readFileSync(join(packageRoot, 'images', name, 'Dockerfile'), 'utf8').matchAll(
          /^FROM\s+(?:--platform=\S+\s+)?(\S+)/gm,
        ),
      ].map((m) => `${name}: ${m[1]!}`),
    );
    const workflows = readdirSync(join(packageRoot, '.github', 'workflows')).flatMap((f) =>
      [
        ...readFileSync(join(packageRoot, '.github', 'workflows', f), 'utf8').matchAll(
          /(\S+@sha256:[0-9a-f]{64})/g,
        ),
      ].map((m) => `${f}: ${m[1]!}`),
    );
    const hub = [...images, ...workflows, `BINFMT: ${BINFMT}`].filter(
      (x) => registryOf(x.split(': ')[1]!) === 'docker.io',
    );
    expect(hub).toEqual([]);
  });

  it('fetch nothing by a name that can move: every clone or fetch pins a commit and checks it', () => {
    const problems = dockerfiles().flatMap(({ name, text }) => {
      const args = argDefaults(text);
      return text
        .split('\n')
        .filter((line) => /\bgit\b.*\b(?:clone|fetch)\b/.test(line) && !line.trim().startsWith('#'))
        .flatMap((line) => {
          // the commit, written out or as an ARG whose default is one
          const commits = [...line.matchAll(/\$\{?(\w+)\}?/g)]
            .map((m) => args.get(m[1]!))
            .filter((v) => v && /^[0-9a-f]{40}$/.test(v));
          const commitVar = [...line.matchAll(/\$\{?(\w+)\}?/g)]
            .map((m) => m[1]!)
            .find((v) => /^[0-9a-f]{40}$/.test(args.get(v) ?? ''));
          if (!commits.length && !/\b[0-9a-f]{40}\b/.test(line)) {
            return [`${name}: ${line.trim()} (no commit)`];
          }
          if (/--branch\b|\s-b\s/.test(line)) {
            return [`${name}: ${line.trim()} (clones a branch or tag)`];
          }
          // and HEAD is checked against it after the fetch
          const checked =
            commitVar && new RegExp(`rev-parse HEAD\\)"? = "?\\$\\{?${commitVar}\\}?`).test(text);
          return checked ? [] : [`${name}: ${line.trim()} (HEAD isn't checked against the commit)`];
        });
    });
    expect(problems).toEqual([]);
  });

  it('check every download: curl or wget output is checked with sha256sum, pip installs by hash', () => {
    const problems = dockerfiles().flatMap(({ name, text }) => {
      const lines = text.split('\n').filter((line) => !line.trim().startsWith('#'));
      const downloads = lines.flatMap((line, i) =>
        /\b(?:curl|wget)\s+-/.test(line) ? [{ line: line.trim(), i }] : [],
      );
      const curl = downloads.flatMap(({ line, i }) => {
        const out =
          /(?:-o|--output|-O)\s+(\S+)/.exec(line)?.[1] ??
          /(?:-o|--output)\s+(\S+)/.exec(lines.slice(i, i + 3).join(' '))?.[1];
        if (!out) {
          return [`${name}: ${line} (no output file to check)`];
        }
        const checked = lines
          .slice(i, i + 4)
          .some((l) => l.includes('sha256sum -c') && l.includes(out.replace(/^"|"$/g, '')));
        return checked ? [] : [`${name}: ${line} (not checked with sha256sum -c)`];
      });
      const pip = lines
        .filter((l) => /\bpip install\b/.test(l) && !l.includes('--require-hashes'))
        .map((l) => `${name}: ${l.trim()} (pip without --require-hashes)`);
      return [...curl, ...pip];
    });
    expect(problems).toEqual([]);
  });

  it('the docs tell people to pull from those registries too', () => {
    const docs = [
      'README.md',
      'DEVELOPMENT.md',
      ...readdirSync(join(packageRoot, 'docs'))
        .filter((f) => f.endsWith('.md'))
        .map((f) => `docs/${f}`),
    ];
    const hub = docs
      .flatMap((f) =>
        // the image a `docker run ... --rm <image>` line names (a $VARIABLE is checked where it is set)
        [
          ...readFileSync(join(packageRoot, f), 'utf8').matchAll(
            /docker run\b[^\n]*?--rm\s+(?:--platform[= ]\S+\s+)?([^\s$-]\S*)/g,
          ),
        ].map((m) => `${f}: ${m[1]!}`),
      )
      .filter((x) => registryOf(x.split(': ')[1]!) === 'docker.io');
    expect(hub).toEqual([]);
  });
});

describe('Dependabot', () => {
  interface Update {
    'package-ecosystem': string;
    directory?: string;
    directories?: string[];
    cooldown?: { 'default-days'?: number };
    'commit-message'?: { prefix?: string };
    ignore?: { 'dependency-name': string; 'update-types'?: string[] }[];
  }
  const config = parse(readFileSync(join(packageRoot, '.github', 'dependabot.yml'), 'utf8')) as {
    updates: Update[];
  };
  const docker = config.updates.find((u) => u['package-ecosystem'] === 'docker');
  /** Whether a Dependabot directory pattern (`*` within one path segment) names `dir`. */
  const covers = (patterns: string[], dir: string) =>
    patterns.some((p) =>
      new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`).test(dir),
    );

  it('keeps every image FROM current (tag and digest), after the same week-long cooldown', () => {
    expect(docker).toBeDefined();
    const dirs = docker!.directories ?? [docker!.directory!];
    const missed = readdirSync(join(packageRoot, 'images'))
      .map((name) => `/images/${name}`)
      .filter((d) => !covers(dirs, d));
    expect(missed).toEqual([]);
    expect(docker!.cooldown?.['default-days']).toBe(7);
    // a conventional PR title: a new base image ships in the next engine release, as a runtime bump does
    expect(docker!['commit-message']?.prefix).toBe('fix');
    // Node follows the engine's (package.json engines), not the newest; a new Ubuntu is a new toolchain, chosen by hand
    // (Dependabot names a FROM image without its registry: mirror.gcr.io/library/node is library/node)
    expect(docker!.ignore).toContainEqual({
      'dependency-name': 'library/node',
      'update-types': ['version-update:semver-major'],
    });
    // Ubuntu's YY.MM tags read as semver: 24.04 -> 24.10 is a "minor", an interim release whose archive goes away
    expect(docker!.ignore).toContainEqual({
      'dependency-name': 'library/ubuntu',
      'update-types': ['version-update:semver-major', 'version-update:semver-minor'],
    });
  });

  it("doesn't merge a base image bump by itself: the toolchain builds (toolchains.yml) aren't its required check", () => {
    const ci = readFileSync(join(packageRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const job = /^ {2}dependabot-auto-merge:\n {4}if: (.+)$/m.exec(ci);
    expect(job?.[1]).toContain("!startsWith(github.head_ref, 'dependabot/docker/')");
  });

  it('merges a base image bump once every toolchain built and tested on it (toolchains.yml)', () => {
    const toolchains = parse(
      readFileSync(join(packageRoot, '.github', 'workflows', 'toolchains.yml'), 'utf8'),
    ) as {
      jobs: Record<
        string,
        { needs?: string[]; if?: string; permissions?: unknown; steps?: { run?: string }[] }
      >;
    };
    const job = toolchains.jobs['dependabot-auto-merge'];
    expect(job?.needs).toEqual(['build', 'native']);
    expect(job?.if).toContain("github.event.pull_request.user.login == 'dependabot[bot]'");
    expect(job?.if).toContain("startsWith(github.head_ref, 'dependabot/docker/')");
    expect(job?.if).toContain("needs.build.result == 'success'");
    expect(job?.if).toContain("needs.native.result == 'success'");
    expect(job?.permissions).toEqual({});
    expect(job?.steps?.at(-1)?.run).toBe('gh pr merge "$PR_URL" --auto --squash');
  });
});
