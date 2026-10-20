import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { fixtureData, fixtureEngineRoot } from './helpers.ts';
import { COMPONENT_KINDS, type Components } from '../src/ffmpeg-components.ts';
import { parseOfferedFile } from '../src/ffmpeg-coverage.ts';
import {
  formatSupport,
  newMajors,
  parseConfigure,
  supportCheck,
  SupportError,
  supportReport,
  writeReleases,
} from '../src/ffmpeg-support.ts';

const emptyComponents = (): Components =>
  Object.fromEntries(COMPONENT_KINDS.map((k) => [k, []])) as unknown as Components;

// the shape of FFmpeg's configure lists: lists of names, some holding other lists by $NAME
const CONFIGURE = [
  'EXTERNAL_AUTODETECT_LIBRARY_LIST="',
  '    zlib',
  '"',
  'EXTERNAL_LIBRARY_GPL_LIST="',
  '    libx264',
  '    libx265',
  '"',
  'EXTERNAL_LIBRARY_NONFREE_LIST="',
  '    libfdk_aac',
  '"',
  'EXTERNAL_LIBRARY_VERSION3_LIST="',
  '    libopencore_amrnb',
  '"',
  'EXTERNAL_LIBRARY_GPLV3_LIST="',
  '    libsmbclient',
  '"',
  'EXTERNAL_LIBRARY_LIST="',
  '    $EXTERNAL_LIBRARY_GPL_LIST',
  '    $EXTERNAL_LIBRARY_NONFREE_LIST',
  '    $EXTERNAL_LIBRARY_VERSION3_LIST',
  '    $EXTERNAL_LIBRARY_GPLV3_LIST',
  '    libdav1d',
  '    libopus',
  '    libsrt',
  '    gnutls',
  '    openssl',
  '    whisper',
  '"',
  'HWACCEL_AUTODETECT_LIBRARY_LIST="',
  '    vaapi',
  '"',
  'HWACCEL_LIBRARY_NONFREE_LIST="',
  '    cuda_nvcc',
  '"',
  'HWACCEL_LIBRARY_LIST="',
  '    $HWACCEL_LIBRARY_NONFREE_LIST',
  '    ffnvcodec',
  '    nvenc',
  '"',
  '',
].join('\n');

describe('the FFmpeg support check', () => {
  it("reads configure's library options and their licence classes, following $LIST references", () => {
    const c = parseConfigure(CONFIGURE);
    expect(c.get('libx265')).toBe('gpl');
    expect(c.get('libfdk_aac')).toBe('nonfree');
    expect(c.get('libopencore_amrnb')).toBe('version3');
    expect(c.get('libsmbclient')).toBe('gplv3');
    expect(c.get('cuda_nvcc')).toBe('nonfree');
    expect(c.get('libdav1d')).toBe('');
    expect(c.has('zlib') && c.has('vaapi') && c.has('nvenc')).toBe(true);
  });

  it("corrects the releases, and reports a new release's new options, what's gone, and a changed class", () => {
    const data = fixtureData();
    const newest = parseConfigure(
      CONFIGURE.replace('    libopus\n', '    libopus\n    libnewcodec\n').replace(
        '    libsrt\n',
        '',
      ),
    );
    const previous = parseConfigure(CONFIGURE);
    const r = supportReport(
      data,
      '9',
      ['9.0', '9.0.1', '9.0.2', '9.1.0', '8.1.3'],
      newest,
      previous,
    );
    expect(r.releases.now).toEqual(['9.0', '9.0.1', '9.0.2', '9.1.0']);
    expect(r.newOptions).toEqual([{ name: 'libnewcodec', license: '' }]);
    expect(r.gone).toEqual(['srt']);
    const text = formatSupport([r], ['10']);
    expect(text).toContain('**new in 9.1.0**');
    expect(text).toContain('`libnewcodec`');
    expect(text).toContain('**gone from configure**, still in the data: `srt`');
    expect(text).toContain('**New FFmpeg major 10**');
  });

  it('names a licence class that changed in configure', () => {
    const data = fixtureData();
    // x265 is gpl in the fixture data; say configure moved it to nonfree
    const moved = parseConfigure(
      CONFIGURE.replace('    libx265\n', '').replace(
        '    libfdk_aac\n',
        '    libfdk_aac\n    libx265\n',
      ),
    );
    const r = supportReport(data, '9', ['9.0.2'], moved, undefined);
    expect(r.reclassed).toEqual([{ option: 'x265', data: 'gpl', configure: 'nonfree' }]);
  });

  it("takes every name an option turns on for its class, not just the first (rkmpp's recipe turns on libdrm too)", () => {
    const data = fixtureData();
    // nv-codec turns on ffnvcodec (no class) first, then nvenc: say configure made nvenc nonfree
    const moved = new Map(parseConfigure(CONFIGURE));
    moved.set('nvenc', 'nonfree');
    expect(supportReport(data, '9', ['9.0.2'], moved, undefined).reclassed).toEqual([
      { option: 'nvenc', data: 'none', configure: 'nonfree' },
    ]);
  });

  it("doesn't report as new what the data already covers, and reports any name gone since the previous release", () => {
    const data = fixtureData();
    // libsrt and vaapi are new in this release's configure, but the data already has srt and vaapi
    const previous = parseConfigure(
      CONFIGURE.replace('    libsrt\n', '')
        .replace('    vaapi\n', '')
        .replace('    libfdk_aac\n', ''),
    );
    const newest = parseConfigure(
      CONFIGURE.replace('    nvenc\n', '').replace('    libdav1d\n', ''),
    );
    const r = supportReport(data, '9', ['9.0.2', '9.1.0'], newest, previous);
    expect(r.newOptions).toEqual([]);
    expect(r.gone).toEqual(['dav1d', 'nvenc']); // nvenc has no lib prefix
    // a name the previous release never had isn't "gone" from this one
    expect(
      supportReport(
        data,
        '9',
        ['9.1.0'],
        parseConfigure(CONFIGURE.replace('    nvenc\n', '')),
        parseConfigure(CONFIGURE.replace('    nvenc\n', '')),
      ).gone,
    ).toEqual([]);
  });

  describe('the whole check', () => {
    const configureOf = async () => parseConfigure(CONFIGURE);
    const root = () => {
      const r = mkdtempSync(join(tmpdir(), 'ffmpeg-build-support-'));
      cpSync(fixtureEngineRoot, r, { recursive: true });
      return r;
    };

    it("refuses to say all is current when upstream's versions couldn't be read", async () => {
      await expect(
        supportCheck({
          data: fixtureData(),
          dataRoot: root(),
          upstream: [],
          configureOf,
          write: false,
        }),
      ).rejects.toThrow(SupportError);
    });

    it('applies the releases with write, and says so', async () => {
      const r = root();
      const text = await supportCheck({
        data: fixtureData(),
        dataRoot: r,
        upstream: ['9.0.0', '9.0.1', '9.0.2', '9.1.0', '9.1.1'],
        configureOf,
        write: true,
      });
      expect(text).toContain('- releases: +9.1.1 (applied)');
      expect(readFileSync(join(r, 'ffmpeg', '9.yml'), 'utf8')).toContain(
        'releases: [9.0.0, 9.0.1, 9.0.2, 9.1.0, 9.1.1]',
      );
      const dry = await supportCheck({
        data: fixtureData(),
        dataRoot: root(),
        upstream: ['9.0.0', '9.0.1', '9.0.2', '9.1.0', '9.1.1'],
        configureOf,
        write: false,
      });
      expect(dry).toContain('(run with --write to apply)');
    });

    it("writes each major's components from its newest release with write, and reports a change", async () => {
      const r = root();
      const upstream = ['9.0.0', '9.0.1', '9.0.2', '9.1.0'];
      const componentsOf = async (version: string) =>
        Promise.resolve({
          components: {
            ...emptyComponents(),
            decoders: version === '9.1.0' ? ['aac', 'h264', 'vvc'] : ['aac', 'h264'],
          },
          names: { decoders: { vvc: 'vvc_dec' } },
          needs: { decoders: { h264: ['libfoo'] } },
          unread: version === '9.1.0' ? ['decoder lost'] : [],
        });
      const text = await supportCheck({
        data: fixtureData(),
        dataRoot: r,
        upstream,
        configureOf,
        componentsOf,
        write: true,
      });
      const file = parse(readFileSync(join(r, 'ffmpeg', 'components', '9.yml'), 'utf8')) as {
        release: string;
        decoders: string[];
        encoders: string[];
        names: unknown;
        needs: unknown;
      };
      expect(file.release).toBe('9.1.0');
      expect(file.decoders).toEqual(['aac', 'h264', 'vvc']);
      expect(file.encoders).toEqual([]);
      expect(file.names).toEqual({ decoders: { vvc: 'vvc_dec' } });
      expect(file.needs).toEqual({ decoders: { h264: ['libfoo'] } });
      expect(text).toContain('- components: from 9.1.0 (applied)');
      // a component whose definition wasn't found keeps its configure name: a person looks
      expect(text).toContain("- **runtime names not read** (configure's used): decoder lost");
      // run again: nothing changed, nothing said
      const again = await supportCheck({
        data: fixtureData(),
        dataRoot: r,
        upstream,
        configureOf,
        componentsOf,
        write: true,
      });
      expect(again).not.toContain('- components:');
    });

    it("writes each major's offered options with write, and names what nothing accounts for", async () => {
      const r = root();
      writeFileSync(
        join(r, 'ffmpeg', 'unsupported.yml'),
        'options:\n  libx264: { reason: pending, issue: 21, note: x264 }\n',
      );
      const offeredOf = async (version: string) =>
        Promise.resolve({
          options: {
            libdav1d: { lists: ['external' as const] },
            libx264: { lists: ['external' as const], license: 'gpl' as const },
            ...(version === '9.1.0'
              ? { libfoo: { lists: ['external' as const], license: 'nonfree' as const } }
              : {}),
          },
          flags: [],
        });
      const check = async () =>
        supportCheck({
          data: fixtureData(),
          dataRoot: r,
          upstream: ['9.0.0', '9.0.1', '9.0.2', '9.1.0'],
          configureOf,
          offeredOf,
          issueOpen: async (n: number) => Promise.resolve(n !== 21),
          write: true,
        });
      const text = await check();
      const file = parseOfferedFile(
        readFileSync(join(r, 'ffmpeg', 'offered', '9.yml'), 'utf8'),
        'ffmpeg/offered/9.yml',
      );
      expect(file.release).toBe('9.1.0');
      expect(Object.keys(file.options)).toEqual(['libdav1d', 'libfoo', 'libx264']);
      expect(text).toContain('- offered options: from 9.1.0 (applied)');
      expect(text).toContain(
        '- **not accounted for** (CI fails until each is supported, or listed in ffmpeg/unsupported.yml): `libfoo` (nonfree)',
      );
      expect(text).toContain(
        '**pending issue closed**: #21 is closed, but ffmpeg/unsupported.yml has pending entries pointing at it: libx264',
      );
      // run again: the file is current, so nothing is said of it
      expect(await check()).not.toContain('- offered options:');
    });

    it("fails when the releases line isn't in the form it rewrites", async () => {
      const r = root();
      const file = join(r, 'ffmpeg', '9.yml');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replace(
          /^releases: \[(.*)\]$/m,
          (_, l: string) =>
            `releases:\n${l
              .split(', ')
              .map((v) => `  - ${v}`)
              .join('\n')}`,
        ),
      );
      await expect(
        supportCheck({
          data: fixtureData(),
          dataRoot: r,
          upstream: ['9.0.0', '9.1.1'],
          configureOf,
          write: true,
        }),
      ).rejects.toThrow('ffmpeg/9.yml: no `releases: [...]` list');
    });
  });

  it('reports an option moved from the gpl list to the gplv3 list', () => {
    const data = fixtureData();
    const moved = parseConfigure(
      CONFIGURE.replace('    libx265\n', '').replace(
        '    libsmbclient\n',
        '    libsmbclient\n    libx265\n',
      ),
    );
    expect(moved.get('libx265')).toBe('gplv3');
    expect(supportReport(data, '9', ['9.0.2'], moved, undefined).reclassed).toEqual([
      { option: 'x265', data: 'gpl', configure: 'gplv3' },
    ]);
  });

  it('rewrites a releases list Prettier wrapped over several lines', () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-support-'));
    cpSync(fixtureEngineRoot, root, { recursive: true });
    const file = join(root, 'ffmpeg', '9.yml');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        /^releases: .*$/m,
        'releases:\n  [\n    9.0,\n    9.0.1,\n  ]',
      ),
    );
    expect(writeReleases(root, '9', ['9.0', '9.0.1', '9.0.2'])).toBe(true);
    expect(readFileSync(file, 'utf8')).toMatch(/^releases: \[9\.0, 9\.0\.1, 9\.0\.2\]$/m);
  });

  it("rewrites only the releases line, and knows a major the data doesn't have", () => {
    const root = mkdtempSync(join(tmpdir(), 'ffmpeg-build-support-'));
    cpSync(fixtureEngineRoot, root, { recursive: true });
    const before = readFileSync(join(root, 'ffmpeg', '9.yml'), 'utf8');
    expect(writeReleases(root, '9', ['9.0', '9.0.1'])).toBe(true);
    const after = readFileSync(join(root, 'ffmpeg', '9.yml'), 'utf8');
    expect(after).toContain('releases: [9.0, 9.0.1]');
    expect(after.replace(/^releases: .*$/m, '')).toBe(before.replace(/^releases: .*$/m, ''));
    expect(newMajors(fixtureData(), ['9.0.2', '10.0', '11.0'])).toEqual(['10', '11']);
  });
});
