import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';
import { parseProfileText } from '../src/profile.ts';
import { planProfile } from '../src/resolve.ts';

const data = loadEngineData(packageRoot);
const LIBRARIES = ['openssl', 'libressl', 'mbedtls'];

describe('TLS backend linking choices', () => {
  it.each(['static', 'shared'] as const)(
    'rejects overlapping %s OpenSSL and LibreSSL providers',
    (openssl) => {
      for (const libressl of ['static', 'shared'] as const) {
        expect(
          linkagePlan(data, ['openssl', 'libressl'], 'linux-x64', {
            openssl,
            libressl,
          }).errors.join('\n'),
        ).toContain('same SSL headers and library names');
      }
    },
  );

  it.each(['lgplv2', 'lgplv3', 'nonfree'])(
    'rejects the unverified LibreSSL-backed librtmp route in %s',
    (license) => {
      const parsed = parseProfileText(
        `name: t\nffmpeg: 9\nplatforms: [linux-x64]\nlicense: ${license}\nwith: [rtmp, libtls]\n`,
        't.yml',
      );
      if (!parsed.ok) {
        throw new Error(parsed.errors.join('\n'));
      }
      expect(planProfile(parsed.profile, data).errors.join('\n')).toContain(
        'LibreSSL-backed librtmp is not verified',
      );
    },
  );
  it.each(LIBRARIES)('%s keeps static defaults and permits vetted shared Linux x64', (name) => {
    expect(linkagePlan(data, [name], 'linux-x64')).toEqual({
      modes: { [name]: 'static' },
      errors: [],
    });
    expect(linkagePlan(data, [name], 'linux-x64', { [name]: 'shared' })).toEqual({
      modes: { [name]: 'shared' },
      errors: [],
    });
    expect(data.recipes.get(name)!.linkage!.modes.shared!.runtime!.length).toBeGreaterThan(0);
  });
  it.each(['openssl', 'mbedtls'])('%s retains static linking on unverified ARM64', (name) => {
    expect(linkagePlan(data, [name], 'linux-arm64').modes[name]).toBe('static');
    expect(linkagePlan(data, [name], 'linux-arm64', { [name]: 'shared' }).errors).toHaveLength(1);
  });
});
