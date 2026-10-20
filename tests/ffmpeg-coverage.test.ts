import { describe, expect, it } from 'vitest';

import { writeEngine } from './helpers.ts';
import { type EngineData, loadEngineData } from '../src/engine-data.ts';
import {
  ConfigureError,
  coverage,
  formatCounts,
  formatCoverage,
  formatOfferedFile,
  issueChecklist,
  type Offered,
  parseOfferedFile,
  parseUnsupported,
  readConfigure,
  readCoverageData,
} from '../src/ffmpeg-coverage.ts';
import { packageRoot } from '../src/paths.ts';

// the shape of FFmpeg's configure: lists of names, some holding other lists by $NAME, and --help's library section
const CONFIGURE = [
  'show_help(){',
  '  cat <<EOF',
  'External library support:',
  '',
  '  Using any of the following switches will allow FFmpeg to link to the',
  '  specifically disabled with --disable-encoder=libopus.',
  '',
  '  --disable-alsa           disable ALSA support [autodetect]',
  '  --enable-libx264         enable H.264 encoding via x264 [no]',
  '  --enable-omx-rpi         enable OpenMAX IL code for Raspberry Pi [no]',
  '',
  'Toolchain options:',
  '  --enable-cross-compile   assume a cross-compiler is used',
  'EOF',
  '}',
  'EXTERNAL_AUTODETECT_LIBRARY_LIST="',
  '    alsa',
  '    zlib',
  '"',
  'EXTERNAL_LIBRARY_GPL_LIST="',
  '    libx264',
  '"',
  'EXTERNAL_LIBRARY_NONFREE_LIST="',
  '    libfdk_aac',
  '"',
  'EXTERNAL_LIBRARY_VERSION3_LIST="',
  '    rkmpp',
  '"',
  'EXTERNAL_LIBRARY_GPLV3_LIST="',
  '    libsmbclient',
  '"',
  'EXTERNAL_LIBRARY_LIST="',
  '    $EXTERNAL_LIBRARY_GPL_LIST',
  '    $EXTERNAL_LIBRARY_NONFREE_LIST',
  '    $EXTERNAL_LIBRARY_VERSION3_LIST',
  '    $EXTERNAL_LIBRARY_GPLV3_LIST',
  '    libsmbclient',
  '    libdav1d',
  '"',
  'HWACCEL_AUTODETECT_LIBRARY_LIST="',
  '    vaapi',
  '"',
  'HWACCEL_LIBRARY_NONFREE_LIST="',
  '    cuda_nvcc',
  '"',
  'HWACCEL_LIBRARY_LIST="',
  '    $HWACCEL_LIBRARY_NONFREE_LIST',
  '    opencl',
  '"',
  'CONFIG_LIST="',
  '    $EXTERNAL_LIBRARY_LIST',
  '    $EXTERNAL_AUTODETECT_LIBRARY_LIST',
  '    $HWACCEL_LIBRARY_LIST',
  '    $HWACCEL_AUTODETECT_LIBRARY_LIST',
  '    gpl',
  '    pic',
  '    $COMPONENT_LIST',
  '"',
  'CMDLINE_SELECT="',
  '    $CONFIG_LIST',
  '    cross_compile',
  '    omx_rpi',
  '"',
  '',
].join('\n');

describe("reading what FFmpeg's configure offers", () => {
  it('reads the four library lists (following $LIST references), their licence classes, and --help', () => {
    const c = readConfigure(CONFIGURE);
    expect(c.options).toEqual({
      alsa: { lists: ['external-autodetect'] },
      cuda_nvcc: { lists: ['hwaccel'], license: 'nonfree' },
      libdav1d: { lists: ['external'] },
      libfdk_aac: { lists: ['external'], license: 'nonfree' },
      libsmbclient: { lists: ['external'], license: 'gplv3' },
      libx264: { lists: ['external'], license: 'gpl' },
      // in --help's library section only (a CMDLINE_SELECT name, in none of the lists)
      omx_rpi: { lists: ['help'] },
      opencl: { lists: ['hwaccel'] },
      rkmpp: { lists: ['external'], license: 'version3' },
      vaapi: { lists: ['hwaccel-autodetect'] },
      zlib: { lists: ['external-autodetect'] },
    });
    expect(Object.keys(c.options)).toEqual(Object.keys(c.options).sort());
    // everything else --enable-/--disable- takes; $COMPONENT_LIST is built at run time, so has nothing here
    expect(c.flags).toEqual(['cross_compile', 'gpl', 'pic']);
  });

  it("fails rather than reading less than configure has: a list missing, or a $LIST that isn't there", () => {
    expect(() =>
      readConfigure(CONFIGURE.replace('HWACCEL_AUTODETECT_LIBRARY_LIST', 'RENAMED_LIST')),
    ).toThrow(ConfigureError);
    expect(() =>
      readConfigure(CONFIGURE.replace('$EXTERNAL_LIBRARY_GPLV3_LIST', '$NO_SUCH_LIST')),
    ).toThrow(/NO_SUCH_LIST/);
    expect(() =>
      readConfigure(CONFIGURE.replace('External library support:', 'Libraries:')),
    ).toThrow(/External library support/);
  });

  it('keeps it as ffmpeg/offered/<major>.yml, one line per option', () => {
    const offered: Offered = { release: '9.0.2', ...readConfigure(CONFIGURE) };
    const text = formatOfferedFile('9', offered);
    expect(text).toContain('release: 9.0.2\n');
    expect(text).toContain('  libx264: { lists: [external], license: gpl }\n');
    expect(text).toContain('  alsa: { lists: [external-autodetect] }\n');
    expect(parseOfferedFile(text, 'ffmpeg/offered/9.yml')).toEqual(offered);
    expect(() => parseOfferedFile('release: 9.0.2\n', 'ffmpeg/offered/9.yml')).toThrow(
      /ffmpeg\/offered\/9\.yml/,
    );
  });
});

describe('ffmpeg/unsupported.yml', () => {
  const ok = 'batches: { d: Filters }\noptions:\n';
  it('reads entries with a reason and a note', () => {
    expect(
      parseUnsupported(
        `${ok}  libvidstab: { reason: pending, issue: 21, batch: d, note: vidstab }\n  libcelt: { reason: deprecated-upstream, majors: [8], note: CELT }\n` +
          '  libsmbclient: { reason: shared-only, note: Samba }\n',
      ),
    ).toEqual({
      batches: { d: 'Filters' },
      options: {
        libvidstab: { reason: 'pending', issue: 21, batch: 'd', note: 'vidstab' },
        libcelt: { reason: 'deprecated-upstream', majors: ['8'], note: 'CELT' },
        libsmbclient: { reason: 'shared-only', note: 'Samba' },
      },
    });
  });

  it.each([
    ['  a: { reason: pending, note: x }', /a: a pending entry needs issue:/],
    ['  a: { reason: pending, issue: 0, note: x }', /issue/],
    ['  a: { reason: because, note: x }', /reason/],
    ['  a: { reason: deprecated-upstream }', /note/],
    ['  a: { reason: alternative-built, note: x }', /a: an alternative-built entry needs instead:/],
    ['  a: { reason: pending, issue: 21, batch: z, note: x }', /batch z isn't one of batches:/],
  ])('turns away %s', (line, message) => {
    expect(() => parseUnsupported(`${ok}${line}\n`)).toThrow(message);
  });
});

const recipe = (name: string, extra = '') =>
  `name: ${name}\nlicense: MIT\nsource: { git: https://example.com/${name} }\nversions: { git-tags: '^v(.*)$' }\nplatforms: all\n${extra}`;

const OPTIONS = [
  'options:',
  '  whep: { builtin: true, kind: muxer }',
  '  zlib: { builtin: true }',
  '  x264: { needs: x264, ffmpeg-license: gpl }',
  '  vaapi: { needs: libva, platforms: [linux-*] }',
  '  d3d11va: { builtin: true, kind: hwaccel, platforms: [win-*] }',
  '  vulkan:',
  '    needs: [{ vulkan-loader: { platforms: [linux-*] } }, { vulkan-headers: { platforms: [win-*] } }]',
  '',
].join('\n');

const ENGINE: Record<string, string> = {
  'platforms.yml': [
    'platforms:',
    '  linux-x64: { image: linux-x64, setup: linux }',
    '  win-x64: { image: cross-windows, setup: mingw }',
    '',
  ].join('\n'),
  'ffmpeg/8.yml': `major: 8\nreleases: [8.1.3]\n${OPTIONS}`,
  'ffmpeg/9.yml': `major: 9\nreleases: [9.0.1, 9.0.2]\n${OPTIONS}`,
  'recipes/x264/recipe.yml': recipe('x264', 'configure: [--enable-libx264]\n'),
  'recipes/libva/recipe.yml': recipe('libva', 'configure: [--enable-vaapi]\nneeds: [libdrm]\n'),
  'recipes/libdrm/recipe.yml': recipe('libdrm'),
  'recipes/vulkan-loader/recipe.yml': recipe('vulkan-loader', 'configure: [--enable-vulkan]\n'),
  'recipes/vulkan-headers/recipe.yml': recipe('vulkan-headers', 'configure: [--enable-vulkan]\n'),
};

function engine(files: Record<string, string> = {}): EngineData {
  return loadEngineData(writeEngine({ ...ENGINE, ...files }));
}

const OFFERED_OPTIONS: Offered['options'] = {
  zlib: { lists: ['external-autodetect'] },
  libx264: { lists: ['external'], license: 'gpl' },
  vaapi: { lists: ['hwaccel-autodetect'] },
  d3d11va: { lists: ['hwaccel-autodetect'] },
  vulkan: { lists: ['hwaccel-autodetect'] },
  libvidstab: { lists: ['external'], license: 'gpl' },
  libcelt: { lists: ['external'] },
};
const offered = (
  release: string,
  extra: Offered['options'] = {},
  without: string[] = [],
): Offered => ({
  release,
  options: Object.fromEntries(
    Object.entries({ ...OFFERED_OPTIONS, ...extra }).filter(([n]) => !without.includes(n)),
  ),
  flags: ['gpl', 'pic'],
});
const UNSUPPORTED = [
  'batches: { d: Filters / processing }',
  'options:',
  '  libvidstab: { reason: pending, issue: 21, batch: d, note: vidstab (video stabilisation) }',
  "  libcelt: { reason: deprecated-upstream, note: 'CELT, part of Opus now' }",
  '',
].join('\n');

const problemsOf = (
  data: EngineData,
  o: Map<string, Offered | undefined>,
  unsupported = UNSUPPORTED,
): string[] => coverage(data, o, parseUnsupported(unsupported)).problems.map((p) => p.text);

const both = (nine: Offered = offered('9.0.2'), eight: Offered = offered('8.1.3')) =>
  new Map<string, Offered | undefined>([
    ['8', eight],
    ['9', nine],
  ]);

describe('coverage: every option FFmpeg offers is supported or listed with a reason', () => {
  it('is clean when every offered option is accounted for, and counts them', () => {
    const c = coverage(engine(), both(), parseUnsupported(UNSUPPORTED));
    expect(c.problems).toEqual([]);
    expect(c.counts.get('9')).toEqual({
      release: '9.0.2',
      offered: 7,
      supported: 5,
      pending: 1,
      notPlanned: { 'deprecated-upstream': 1 },
    });
    expect(formatCounts(c.counts)).toBe(
      [
        '| FFmpeg | offered | supported | pending | not planned |',
        '| --- | --- | --- | --- | --- |',
        '| 8 (8.1.3) | 7 | 5 | 1 | 1 (deprecated-upstream 1) |',
        '| 9 (9.0.2) | 7 | 5 | 1 | 1 (deprecated-upstream 1) |',
        '',
      ].join('\n'),
    );
  });

  it('names every offered option that is neither supported nor listed, and says what to do', () => {
    const data = engine();
    const c = coverage(
      data,
      both(
        offered('9.0.2', {
          libfoo: { lists: ['external'], license: 'nonfree' },
          alsa: { lists: ['external-autodetect'] },
        }),
      ),
      parseUnsupported(UNSUPPORTED),
    );
    expect(c.problems.map((p) => p.text)).toEqual([
      "FFmpeg 9 (9.0.2) offers --enable-alsa, but no option of ffmpeg/9.yml turns it on and ffmpeg/unsupported.yml doesn't list it",
      "FFmpeg 9 (9.0.2) offers --enable-libfoo (nonfree), but no option of ffmpeg/9.yml turns it on and ffmpeg/unsupported.yml doesn't list it",
    ]);
    const text = formatCoverage(c.problems);
    expect(text).toMatch(/^2 problems with what the engine supports of FFmpeg's configure/);
    expect(text).toContain(
      'a recipe whose configure: turns it on, and an option in ffmpeg/<major>.yml',
    );
    expect(text).toContain('libfoo: { reason: pending, issue: <n>, note: <what it is> }');
    expect(text).toContain('Adding support for an FFmpeg option');
  });

  it('keeps an entry to the majors it names: one for FFmpeg 8 is no excuse on 9', () => {
    expect(
      problemsOf(
        engine(),
        both(offered('9.0.2'), offered('8.1.3')),
        UNSUPPORTED.replace("note: 'CELT", "majors: [8], note: 'CELT"),
      ),
    ).toEqual([
      "FFmpeg 9 (9.0.2) offers --enable-libcelt, but no option of ffmpeg/9.yml turns it on and ffmpeg/unsupported.yml doesn't list it",
    ]);
  });

  it('finds stale entries: supported now, offered by no FFmpeg the engine knows, or not by a major they name', () => {
    expect(
      problemsOf(
        engine(),
        both(offered('9.0.2', {}, ['libcelt']), offered('8.1.3', {}, ['libcelt'])),
        `${UNSUPPORTED}  libx264: { reason: pending, issue: 21, note: x264 }\n  vaapi: { reason: platform-not-built, majors: [9], note: x }\n  zlib: { reason: platform-not-built, majors: [7], note: x }\n`,
      ),
    ).toEqual([
      'ffmpeg/unsupported.yml lists libcelt, but no FFmpeg major the engine knows offers it (8.1.3, 9.0.2): remove the entry',
      "ffmpeg/unsupported.yml lists libx264, but ffmpeg/8.yml's option x264 turns it on: remove the entry, or give it majors: without 8",
      "ffmpeg/unsupported.yml lists libx264, but ffmpeg/9.yml's option x264 turns it on: remove the entry, or give it majors: without 9",
      "ffmpeg/unsupported.yml lists vaapi, but ffmpeg/9.yml's option vaapi turns it on: remove the entry, or give it majors: without 9",
      'ffmpeg/unsupported.yml lists zlib for FFmpeg 7 (majors:), which the engine has no ffmpeg/7.yml for',
    ]);
  });

  it('finds an entry naming a major that no longer offers the option', () => {
    expect(
      problemsOf(
        engine(),
        both(offered('9.0.2', {}, ['libcelt'])),
        UNSUPPORTED.replace("note: 'CELT", "majors: [8, 9], note: 'CELT"),
      ),
    ).toEqual([
      "ffmpeg/unsupported.yml lists libcelt for FFmpeg 9 (majors:), but FFmpeg 9.0.2 doesn't offer it: take 9 out of its majors:",
    ]);
  });

  it("needs each major's offered file, read at its newest release", () => {
    expect(
      problemsOf(
        engine(),
        new Map<string, Offered | undefined>([
          ['8', undefined],
          ['9', offered('9.0.1')],
        ]),
      ),
    ).toEqual([
      'ffmpeg/offered/8.yml is missing: run `node scripts/ffmpeg-support.ts --write` to write it',
      "ffmpeg/offered/9.yml is from FFmpeg 9.0.1, not ffmpeg/9.yml's newest release 9.0.2: run `node scripts/ffmpeg-support.ts --write`",
    ]);
  });

  it('checks every flag the data turns on is one configure takes', () => {
    const data = engine({
      'recipes/x264/recipe.yml': recipe('x264', 'configure: [--enable-libx246]\n'),
      'ffmpeg/9.yml': `major: 9\nreleases: [9.0.2]\n${OPTIONS}  pic: { builtin: true, configure: [--enable-pic, --disable-gpl] }\n`,
    });
    expect(problemsOf(data, both())).toEqual([
      "ffmpeg/8.yml's option x264 turns on --enable-libx246, which FFmpeg 8.1.3's configure doesn't take",
      "ffmpeg/9.yml's option x264 turns on --enable-libx246, which FFmpeg 9.0.2's configure doesn't take",
      "FFmpeg 8 (8.1.3) offers --enable-libx264 (gpl), but no option of ffmpeg/8.yml turns it on and ffmpeg/unsupported.yml doesn't list it",
      "FFmpeg 9 (9.0.2) offers --enable-libx264 (gpl), but no option of ffmpeg/9.yml turns it on and ffmpeg/unsupported.yml doesn't list it",
    ]);
  });

  it("checks an option's ffmpeg-license against configure's classes of everything it turns on", () => {
    const data = engine({
      'ffmpeg/9.yml': `major: 9\nreleases: [9.0.2]\n${OPTIONS.replace('ffmpeg-license: gpl', 'ffmpeg-license: version3')}`,
      // vaapi turns on libdrm (no class) and rkmpp (version3): together, version3
      'ffmpeg/8.yml': `major: 8\nreleases: [8.1.3]\n${OPTIONS.replace('platforms: [linux-*] }', 'platforms: [linux-*], ffmpeg-license: version3 }')}`,
      'recipes/libva/recipe.yml': recipe(
        'libva',
        'configure: [--enable-vaapi, --enable-rkmpp]\nneeds: [libdrm]\n',
      ),
    });
    const withRkmpp = (o: Offered) => ({
      ...o,
      options: {
        ...o.options,
        rkmpp: { lists: ['external' as const], license: 'version3' as const },
      },
    });
    expect(
      problemsOf(data, both(withRkmpp(offered('9.0.2')), withRkmpp(offered('8.1.3')))),
    ).toEqual([
      "ffmpeg/9.yml's option x264 has ffmpeg-license: version3, but configure's classes for what it turns on (libx264 gpl) make it gpl",
      "ffmpeg/9.yml's option vaapi has no ffmpeg-license:, but configure's classes for what it turns on (rkmpp version3) make it version3",
    ]);
  });

  it('finds recipes nothing builds, and options whose library builds on no platform', () => {
    const data = engine({
      'recipes/orphan/recipe.yml': recipe('orphan'),
      'recipes/x264/recipe.yml': recipe('x264', 'configure: [--enable-libx264]\n').replace(
        'platforms: all',
        'platforms: [osx-*]',
      ),
    });
    expect(problemsOf(data, both())).toEqual([
      "ffmpeg/8.yml's option x264: its library x264 builds on no platform the engine builds (platforms.yml) where the option applies",
      "ffmpeg/9.yml's option x264: its library x264 builds on no platform the engine builds (platforms.yml) where the option applies",
      "FFmpeg 8 (8.1.3) offers --enable-libx264 (gpl), but no option of ffmpeg/8.yml turns it on and ffmpeg/unsupported.yml doesn't list it",
      "FFmpeg 9 (9.0.2) offers --enable-libx264 (gpl), but no option of ffmpeg/9.yml turns it on and ffmpeg/unsupported.yml doesn't list it",
      'recipes/orphan is built for no option: no option of any ffmpeg/<major>.yml needs it, and no recipe needs or uses it',
    ]);
  });

  it('needs an alternative-built entry to name an option of every major it is for', () => {
    expect(
      problemsOf(
        engine(),
        both(),
        UNSUPPORTED.replace(
          'reason: deprecated-upstream, note',
          'reason: alternative-built, instead: opus, note',
        ),
      ),
    ).toEqual([
      "ffmpeg/unsupported.yml: libcelt's instead: opus isn't an option of ffmpeg/8.yml",
      "ffmpeg/unsupported.yml: libcelt's instead: opus isn't an option of ffmpeg/9.yml",
    ]);
  });
});

describe('the issue checklist', () => {
  it('prints the pending entries by batch, and the rest with their reasons', () => {
    const text = issueChecklist(parseUnsupported(UNSUPPORTED));
    expect(text).toContain(
      '### d. Filters / processing\n\n- [ ] vidstab (video stabilisation): `libvidstab`\n',
    );
    expect(text).toContain(
      '### Not planned\n\n- `libcelt` (deprecated-upstream): CELT, part of Opus now\n',
    );
  });
});

describe("the engine's own data", () => {
  it("accounts for every option FFmpeg's configure offers, in every major (see DEVELOPMENT.md if this fails)", () => {
    const data = loadEngineData(packageRoot);
    const { offered: o, unsupported } = readCoverageData(data);
    const report = formatCoverage(coverage(data, o, unsupported).problems);
    expect(report, report).toBe('');
  });
});
