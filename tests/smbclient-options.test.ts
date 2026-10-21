import { describe, expect, it } from 'vitest';

import { configureFlags } from '../src/build/plan.ts';
import { loadEngineData } from '../src/engine-data.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);

describe('Samba client', () => {
  const resolve = (extra = '') => {
    const parsed = parseProfileText(
      `name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: nonfree\nwith: [smbclient, libtls]\n${extra}`,
      't.yml',
    );
    if (!parsed.ok) {
      throw new Error(parsed.errors.join('\n'));
    }
    return planProfile(parsed.profile, data, { '9': '9.0.2' });
  };

  it('bundles only its verified shared mode and rejects a static override', () => {
    const plan = resolve();
    expect(plan.errors).toEqual([]);
    expect(plan.cells[0]!.linkages?.['samba']).toBe('shared');
    expect(resolve('link: { samba: static }\n').errors).toEqual([
      expect.stringContaining('link: samba does not support static linking on linux-x64'),
    ]);
    expect(resolve('link: { samba: shared }\n').errors).toEqual([]);
  });

  it('keeps internal GnuTLS separate from the selected FFmpeg TLS provider', () => {
    const plan = resolve();
    const cell = plan.cells[0]!;
    expect(cell.recipes).toContain('gnutls');
    expect(cell.groups['tls']).toBe('libtls');
    expect(configureFlags(data, cell)).toContain('--enable-libtls');
    expect(configureFlags(data, cell)).not.toContain('--enable-gnutls');
    expect(configureFlags(data, cell)).toContain('--enable-libsmbclient');
  });

  it.each(['8', '9'])('%s is opt-in for GPLv3 and nonfree builds', (major) => {
    for (const license of ['lgplv2', 'lgplv3', 'gplv2', 'gplv3', 'nonfree']) {
      const parsed = parseProfileText(
        `name: t\nffmpeg: ${major}\nplatforms: [linux-x64]\nlicense: ${license}\nwith: [smbclient]\n`,
        't.yml',
      );
      if (!parsed.ok) {
        throw new Error(parsed.errors.join('\n'));
      }
      const plan = planProfile(parsed.profile, data, {
        [major]: major === '8' ? '8.1.3' : '9.0.2',
      });
      expect(plan.cells[0]!.recipes.includes('samba')).toBe(['gplv3', 'nonfree'].includes(license));
    }
  });
});
