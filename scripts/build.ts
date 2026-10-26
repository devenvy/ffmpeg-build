import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function buildPackage(root: string): number {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  return (
    spawnSync(
      process.execPath,
      [require.resolve('typescript/lib/tsc.js'), '-p', 'tsconfig.build.json'],
      {
        cwd: root,
        stdio: 'inherit',
      },
    ).status ?? 1
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = buildPackage(fileURLToPath(new URL('../', import.meta.url)));
}
