// Where the engine's build modules (the worker and what it runs) are: the TypeScript in a source checkout, the compiled
// JavaScript in an installed package. The package ships dist/ only, and Node won't strip types under node_modules anyway.
// The worker that runs, the toolchain identity that hashes them, and the release bundle that carries them all use this.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildModules {
  dir: 'src/build' | 'dist/build';
  ext: '.ts' | '.js';
}

export function buildModules(root: string): BuildModules {
  const installed = /[\\/]node_modules[\\/]/.test(root);
  return !installed && existsSync(join(root, 'src', 'build', 'worker.ts'))
    ? { dir: 'src/build', ext: '.ts' }
    : { dir: 'dist/build', ext: '.js' };
}

/** The build worker's path under `root` (a host path, or the package's mount point in a container). */
export function workerPath(
  root: string,
  modules: BuildModules,
  sep: 'host' | 'posix' = 'host',
): string {
  const rel = `${modules.dir}/worker${modules.ext}`;
  return sep === 'posix' ? `${root.replace(/\/$/, '')}/${rel}` : join(root, ...rel.split('/'));
}
