import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { makeBuildPlan } from '../src/build/plan.ts';
import { elfRequirements, systemCheckEnv } from '../src/build/runtime-dependencies.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);
const locked = {
  ffmpeg: { '9': '9.0.2' },
  libraries: { libgcrypt: '1.12.4', 'libgpg-error': '1.61' },
  pinned: [],
};
describe('system shared runtime', () => {
  it('makes only explicitly omitted libraries visible while verifying the archive', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ffb-system-env-'));
    const lib = join(dir, 'deps', 'lib');
    try {
      mkdirSync(lib, { recursive: true });
      writeFileSync(join(lib, 'libselected.so.1'), 'selected');
      writeFileSync(join(lib, 'libbundled-but-missing.so.1'), 'must not be found here');
      const env = systemCheckEnv({
        work: dir,
        depsDir: join(dir, 'deps'),
        env: { LD_LIBRARY_PATH: lib },
        buildPlan: {
          systemLibraries: [
            { name: 'selected', version: '1', runtime: ['lib/libselected.so*'], packages: {} },
          ],
        },
      });
      expect(env['LD_LIBRARY_PATH']).not.toBe(lib);
      expect(existsSync(join(env['LD_LIBRARY_PATH']!, 'libselected.so.1'))).toBe(true);
      expect(existsSync(join(env['LD_LIBRARY_PATH']!, 'libbundled-but-missing.so.1'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('reports actual ELF library ABI names and required symbol versions', () => {
    expect(
      elfRequirements(
        '0x1 (NEEDED) Shared library: [libgcrypt.so.20]\n0x1 (NEEDED) Shared library: [libc.so.6]',
        '0x0: Version: 1 File: libgcrypt.so.20 Cnt: 1\n0x10: Name: GCRYPT_1.6 Flags: none\n0x20: Version: 1 File: libc.so.6 Cnt: 1\n0x30: Name: GLIBC_2.17 Flags: none',
      ),
    ).toEqual({
      needed: ['libgcrypt.so.20', 'libc.so.6'],
      symbolVersions: { 'libgcrypt.so.20': ['GCRYPT_1.6'], 'libc.so.6': ['GLIBC_2.17'] },
    });
  });
  it('builds the selected shared libraries but leaves their runtime files outside the archive', () => {
    const parsed = parseProfileText(
      'name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: lgplv2\nwith: [gcrypt]\nlink: { libgcrypt: system-shared, libgpg-error: system-shared }\n',
      't.yml',
    );
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('\n'));
    }
    const plan = planProfile(parsed.profile, data, locked.ffmpeg);
    expect(plan.errors).toEqual([]);
    const build = makeBuildPlan({
      profile: parsed.profile,
      data,
      locked,
      cell: plan.cells[0]!,
      variant: 't',
      imageId: 'toolchain',
      cacheDir: '/not-cached',
    });
    expect(build.runtime).toEqual([]);
    expect(build.libraries.find((l) => l.name === 'libgcrypt')!.build.vars['shared-arg']).toBe(
      '--enable-shared',
    );
    expect(build.systemLibraries?.map((l) => l.name)).toEqual(['libgpg-error', 'libgcrypt']);
    expect(build.systemLibraries?.find((l) => l.name === 'libgcrypt')!.packages['fedora']).toEqual([
      'libgcrypt',
    ]);
  });
});
