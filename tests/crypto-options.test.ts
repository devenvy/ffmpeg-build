import { describe, expect, it } from 'vitest';

import { configureFlags } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);

describe('gcrypt alternative', () => {
  it.each(['8', '9'])('%s enables gcrypt without silently selecting GMP or TLS', (major) => {
    for (const license of ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree']) {
      const parsed = parseProfileText(
        `name: t\nffmpeg: ${major}\nplatforms: [linux-x64]\nlicense: ${license}\nwith: [gcrypt]\n`,
        't.yml',
      );
      if (!parsed.ok) {
        throw new Error(parsed.errors.join('\n'));
      }
      const plan = planProfile(parsed.profile, data, {
        [major]: major === '8' ? '8.1.3' : '9.0.2',
      });
      expect(plan.errors).toEqual([]);
      expect(plan.cells[0]!.recipes).toEqual(['libgpg-error', 'libgcrypt']);
      expect(configureFlags(data, plan.cells[0]!)).toContain('--enable-gcrypt');
      expect(configureFlags(data, plan.cells[0]!)).not.toContain('--enable-gmp');
    }
  });
});

describe('LibreSSL TLS alternative', () => {
  it.each(['8', '9'])('%s offers libtls under LGPL or nonfree, with one TLS provider', (major) => {
    for (const license of ['lgplv2', 'lgplv3', 'nonfree']) {
      const parsed = parseProfileText(
        `name: t\nffmpeg: ${major}\nplatforms: [linux-x64]\nlicense: ${license}\nwith: [libtls, gcrypt]\n`,
        't.yml',
      );
      if (!parsed.ok) {
        throw new Error(parsed.errors.join('\n'));
      }
      const plan = planProfile(parsed.profile, data, {
        [major]: major === '8' ? '8.1.3' : '9.0.2',
      });
      expect(plan.errors).toEqual([]);
      expect(plan.cells[0]!.recipes).toContain('libressl');
      expect(plan.cells[0]!.groups['tls']).toBe('libtls');
      expect(configureFlags(data, plan.cells[0]!)).toContain('--enable-libtls');
    }
  });
});
