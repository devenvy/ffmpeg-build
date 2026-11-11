// What the shipped binaries load from the system at run time, which the archives don't carry: the ELF NEEDED entries,
// PE imports and Mach-O load commands of every library and program staged, less what the archive itself provides.
// Read from the staged files (src/build/stage.ts runs readelf, objdump or otool); recorded in the SBOM as the host's,
// not in THIRD-PARTY-NOTICES.txt, which covers what ships.
import { basename } from 'node:path';

/** A staged binary and what it loads: sonames, DLL names or install names, as its format records them. */
export interface StagedBinary {
  file: string; // its path in the archive
  format: 'ELF' | 'PE' | 'Mach-O';
  loads: string[];
  soname?: string; // ELF: the name others load it by
}

/** A library the host provides: what loads it, and, for a group (the UCRT's API sets), its members. */
export interface HostLoad {
  name: string;
  format: StagedBinary['format'];
  needers: string[];
  members?: string[];
}

/** The DLL names a PE file imports, as `objdump -p` lists them. */
export function peImports(objdump: string): string[] {
  return [...objdump.matchAll(/^\s*DLL Name:\s*(\S+)\s*$/gm)].map((m) => m[1]!);
}

/** An ELF program's dynamic loader, as `readelf -lW` prints its PT_INTERP; none for a library. */
export function elfInterpreter(readelf: string): string | undefined {
  return /\[Requesting program interpreter: ([^\]]+)\]/.exec(readelf)?.[1];
}

/** The Universal C Runtime's API sets, one host component (api-ms-win-crt-*.dll, Windows 10 and later or its update). */
const UCRT_API_SET = /^api-ms-win-crt-/i;
const UCRT = 'Universal C Runtime (api-ms-win-crt-*.dll)';

/**
 * What the binaries load that the archive doesn't provide: an ELF soname no staged file has (by name or SONAME), a DLL
 * no staged file is (names compared without case), a Mach-O install name outside the bundle (@rpath, @loader_path and
 * @executable_path are the archive's own). The UCRT's API sets are one entry, with its members.
 */
export function hostLoads(
  binaries: readonly StagedBinary[],
  staged: readonly string[],
): HostLoad[] {
  const provided = new Set(
    [
      ...staged.map((path) => basename(path)),
      ...binaries.flatMap((b) => (b.soname ? [b.soname] : [])),
    ].map((name) => name.toLowerCase()),
  );
  const found = new Map<string, HostLoad>();
  for (const binary of [...binaries].sort((a, b) => a.file.localeCompare(b.file))) {
    // the archive's own: an @-relative Mach-O install name, or a file it stages (by name, SONAME or the install name's
    // file name)
    const own = (load: string) =>
      binary.format === 'Mach-O'
        ? load.startsWith('@') || provided.has(basename(load).toLowerCase())
        : provided.has(load.toLowerCase());
    for (const load of binary.loads.filter((name) => !own(name))) {
      const group = binary.format === 'PE' && UCRT_API_SET.test(load) ? UCRT : undefined;
      const key = (group ?? load).toLowerCase();
      const entry = found.get(key) ?? { name: group ?? load, format: binary.format, needers: [] };
      if (!entry.needers.includes(binary.file)) {
        entry.needers.push(binary.file);
      }
      if (group) {
        entry.members = [...new Set([...(entry.members ?? []), load.toLowerCase()])].sort();
      }
      found.set(key, entry);
    }
  }
  return [...found.values()].sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
}
