// A workflow that calls a reusable one must grant every permission the called jobs declare, even for jobs its inputs
// skip: GitHub checks that before anything runs, and the run fails at startup otherwise.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { packageRoot } from '../src/paths.ts';

type Permissions = Record<string, string> | string | undefined;
interface Job {
  uses?: string;
  permissions?: Permissions;
}
interface Workflow {
  permissions?: Permissions;
  jobs?: Record<string, Job>; // parsed YAML: a file may have none
}

const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 };
const read = (path: string) => parse(readFileSync(path, 'utf8')) as Workflow;
const asMap = (p: Permissions): Record<string, string> => (typeof p === 'object' ? p : {});

/** The most each scope is asked for by any job of a reusable workflow (or its top level). */
function needs(file: string): Record<string, string> {
  const w = read(join(packageRoot, '.github', 'workflows', file));
  const out: Record<string, string> = {};
  for (const p of [w.permissions, ...Object.values(w.jobs ?? {}).map((j) => j.permissions)]) {
    for (const [k, v] of Object.entries(asMap(p))) {
      if ((LEVEL[v] ?? 0) > (LEVEL[out[k] ?? 'none'] ?? 0)) {
        out[k] = v;
      }
    }
  }
  return out;
}

const callers = [
  ...readdirSync(join(packageRoot, 'examples', 'workflows'))
    .filter((f) => f.endsWith('.yml'))
    .map((f) => join(packageRoot, 'examples', 'workflows', f)),
  ...readdirSync(join(packageRoot, '.github', 'workflows'))
    .filter((f) => f.endsWith('.yml'))
    .map((f) => join(packageRoot, '.github', 'workflows', f)),
];

describe('workflow permissions', () => {
  // the top level only reads; each write is the job's that needs it (OpenSSF Scorecard's Token-Permissions)
  for (const path of callers) {
    it(`${relative(packageRoot, path).replaceAll('\\', '/')} writes nothing at its top level`, () => {
      const top = read(path).permissions;
      expect(top === 'write-all' || Object.values(asMap(top)).includes('write')).toBe(false);
    });
  }
});

describe('step outputs', () => {
  // a value written to $GITHUB_ENV reaches every later step, and one built from an input is what CodeQL's
  // envvar-injection query flags: a step passes what it works out as a step output, to the steps that need it
  for (const path of callers) {
    it(`${relative(packageRoot, path).replaceAll('\\', '/')} writes nothing to GITHUB_ENV`, () => {
      expect(readFileSync(path, 'utf8')).not.toContain('GITHUB_ENV');
    });
  }
});

describe('reusable workflow callers', () => {
  // each job that calls one of the engine's reusable workflows, with the file it calls
  const calls = callers.flatMap((path) => {
    const w = read(path);
    return Object.entries(w.jobs ?? {}).flatMap(([id, job]) => {
      const called = /\.github\/workflows\/([\w-]+\.yml)/.exec(job.uses ?? '')?.[1];
      return called ? [{ path, w, id, job, called }] : [];
    });
  });
  for (const { path, w, id, job, called } of calls) {
    it(`${relative(packageRoot, path).replaceAll('\\', '/')} job ${id} grants what ${called} asks for`, () => {
      const granted = { ...asMap(w.permissions), ...asMap(job.permissions) };
      const short = Object.entries(needs(called))
        .filter(([k, v]) => (LEVEL[granted[k] ?? 'none'] ?? 0) < (LEVEL[v] ?? 0))
        .map(([k, v]) => `${k}: ${v}`);
      expect(short).toEqual([]);
    });
  }
});
