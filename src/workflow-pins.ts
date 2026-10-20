// The reusable workflows a repository calls, against the engine its ffmpeg.lock records. The workflows install the
// lock's engine, and update-lock moves it daily, while the workflow pin (`uses: .../build.yml@<sha> # v0.0.9`) moves
// when Dependabot moves it. Any engine of the workflows' major runs on them (the @v0 contract), so a difference is a
// note, never a failure: it says the engine is running without what its own workflows would give it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { LOCK_FILE } from './lockfile.ts';

/** A job calling one of ffmpeg-build's workflows: `uses: <owner>/ffmpeg-build/.github/workflows/<file>@<ref> # <v>`. */
const CALL =
  /^\s*(?:-\s+)?uses:\s*['"]?[\w.-]+\/ffmpeg-build\/\.github\/workflows\/([\w.-]+\.ya?ml)@([\w./-]+)['"]?[ \t]*(?:#[ \t]*(\S+))?/gm;
/** A release tag or version: v0.0.9, 0.0.9 (a major tag like v0, a branch, or a bare commit says no release). */
const RELEASE = /^v?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/;

/** The repository `dir` is in: the nearest folder up with a .git. */
function repositoryRoot(dir: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) {
      return d;
    }
    if (dirname(d) === d) {
      return undefined;
    }
  }
}

/**
 * One line for each call of ffmpeg-build's workflows in the repository's .github/workflows pinned to a release other
 * than `engine` (ffmpeg.lock's): a `::warning` on GitHub Actions, else a note.
 */
export function workflowPinNotes(dir: string, engine: string, env: NodeJS.ProcessEnv): string[] {
  const root = repositoryRoot(dir);
  const workflows = root && join(root, '.github', 'workflows');
  if (!workflows || !existsSync(workflows)) {
    return [];
  }
  const notes: string[] = [];
  for (const name of readdirSync(workflows)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const file = relative(root, join(workflows, name)).replaceAll('\\', '/');
    for (const [, called, ref, comment] of readFileSync(join(workflows, name), 'utf8').matchAll(
      CALL,
    )) {
      const release = RELEASE.exec(comment ?? '')?.[1] ?? RELEASE.exec(ref!)?.[1];
      if (release && release !== engine) {
        const major = engine.split('.')[0]!;
        const text = `${file} calls ffmpeg-build's ${called!} at v${release}, but ${LOCK_FILE}'s engine is ${engine}: any ${major}.x engine runs on the @v${major} workflows, but they are its own only at v${engine} (Dependabot moves the pin; or set it by hand)`;
        notes.push(
          env['GITHUB_ACTIONS'] === 'true'
            ? `::warning file=${file},title=ffmpeg-build workflows behind the engine::${text}`
            : `note: ${text}`,
        );
      }
    }
  }
  return notes;
}
