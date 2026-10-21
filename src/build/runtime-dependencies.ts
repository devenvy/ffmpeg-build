import {
  copyFileSync,
  globSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { run, step } from './run.ts';

import type { BuildContext } from './library.ts';

const JSON_INDENT = 2;

/** ELF ABI names and versioned symbols, read from binaries rather than inferred from source versions. */
export function elfRequirements(
  dynamic: string,
  versions: string,
): {
  soname?: string;
  needed: string[];
  symbolVersions: Record<string, string[]>;
} {
  const soname = /\(SONAME\).*\[(.*?)\]/.exec(dynamic)?.[1];
  const needed = [...dynamic.matchAll(/\(NEEDED\).*\[(.*?)\]/g)].map((m) => m[1]!);
  const symbolVersions: Record<string, string[]> = {};
  let file: string | undefined;
  for (const line of versions.split(/\r?\n/)) {
    file = /\bFile:\s+(\S+)/.exec(line)?.[1] ?? file;
    const name = /\bName:\s+(\S+)/.exec(line)?.[1];
    if (file && name) {
      symbolVersions[file] = [...new Set([...(symbolVersions[file] ?? []), name])].sort();
    }
  }
  return { ...(soname ? { soname } : {}), needed, symbolVersions };
}

/** Source-built shared libraries used for build verification, but intentionally omitted from the runtime archive. */
function systemLibraryPaths(
  context: Pick<BuildContext, 'depsDir'> & {
    buildPlan: Pick<BuildContext['buildPlan'], 'systemLibraries'>;
  },
): string[] {
  return [
    ...new Set(
      (context.buildPlan.systemLibraries ?? []).flatMap((l) =>
        l.runtime.flatMap((pattern) =>
          globSync(join(context.depsDir, pattern).replaceAll('\\', '/')),
        ),
      ),
    ),
  ];
}

/** The build verifies against its own dependencies; this does not change the staged binaries' search paths. */
export function systemCheckEnv(
  context: Pick<BuildContext, 'work' | 'env' | 'depsDir'> & {
    buildPlan: Pick<BuildContext['buildPlan'], 'systemLibraries'>;
  },
): NodeJS.ProcessEnv {
  if (!context.buildPlan.systemLibraries?.length) {
    return context.env;
  }
  // Expose only the explicitly omitted libraries. Pointing at deps/lib would
  // hide a missing bundled dependency by loading its build copy instead.
  const directory = mkdtempSync(join(context.work, 'system-check-'));
  for (const path of systemLibraryPaths(context)) {
    copyFileSync(realpathSync(path), join(directory, basename(path)));
  }
  return {
    ...context.env,
    LD_LIBRARY_PATH: directory,
  };
}

/** Best-effort installation guidance. Package suggestions never block a build or release. */
export async function writeRuntimeDependencies(
  context: BuildContext,
  runDir: string,
  devDir: string,
): Promise<void> {
  const libraries = context.buildPlan.systemLibraries;
  if (!libraries?.length) {
    return;
  }
  const binaries = readdirSync(runDir)
    .filter((name) => /^(ffmpeg|ffprobe)$|\.so(?:\.|$)/.test(name))
    .map((name) => join(runDir, name));
  const inputs = [...new Set([...binaries, ...systemLibraryPaths(context)])].filter(
    (path) => !lstatSync(path).isSymbolicLink(),
  );
  const requirements = [];
  for (const path of inputs) {
    try {
      const dynamic = await run('readelf', ['-dW', path], { env: context.env, capture: true });
      const versions = await run('readelf', ['--version-info', '-W', path], {
        env: context.env,
        capture: true,
      });
      requirements.push({
        file: basename(path),
        bundled: dirname(path) === runDir,
        ...elfRequirements(dynamic, versions),
      });
    } catch (error) {
      requirements.push({ file: basename(path), inspectionError: String(error) });
      step(`dependency guidance: could not inspect ${basename(path)}`);
    }
  }
  const report = {
    platform: context.buildPlan.platform,
    guidance:
      'Package names are best-effort suggestions. requirements describes the shipped binaries. referenceProviders describes source-built libraries omitted from the archive; distribution providers can have different internal dependencies. The source build version is not a minimum package version.',
    libraries: libraries.map((l) => ({
      name: l.name,
      builtVersion: l.version,
      packages: l.packages,
    })),
    requirements: requirements.filter((row) => 'bundled' in row && row.bundled),
    referenceProviders: requirements.filter((row) => !('bundled' in row) || !row.bundled),
  };
  const packages = new Map<string, Set<string>>();
  for (const library of libraries) {
    for (const [distribution, names] of Object.entries(library.packages)) {
      const found = packages.get(distribution) ?? new Set<string>();
      names.forEach((name) => {
        found.add(name);
      });
      packages.set(distribution, found);
    }
  }
  const commands: Record<string, string> = {
    debian: 'apt-get install',
    ubuntu: 'apt-get install',
    fedora: 'dnf install',
  };
  const text = [
    `External shared libraries for ${context.buildPlan.name} (${context.buildPlan.platform})`,
    '',
    'This archive intentionally omits the following source-built libraries:',
    ...libraries.map(
      (l) => `  ${l.name} (built against ${l.version}; not a minimum package version)`,
    ),
    '',
    'Best-effort package suggestions:',
    ...[...packages].map(
      ([distribution, names]) =>
        `  ${distribution}: ${commands[distribution] ?? 'packages:'} ${[...names].sort().join(' ')}`,
    ),
    '',
    'Install compatible providers of the ABI names and symbol versions in RUNTIME-DEPENDENCIES.json.',
    'The requirements section describes the shipped binaries. referenceProviders describes the omitted build copies,',
    'whose internal dependencies may differ from your distribution packages. Package names are suggestions,',
    'not a compatibility guarantee. No package mapping is required to build or release this archive.',
    '',
  ].join('\n');
  for (const dir of [runDir, devDir]) {
    writeFileSync(
      join(dir, 'RUNTIME-DEPENDENCIES.json'),
      `${JSON.stringify(report, null, JSON_INDENT)}\n`,
    );
    writeFileSync(join(dir, 'RUNTIME-DEPENDENCIES.txt'), text);
  }
}
