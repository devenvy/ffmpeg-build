import { z } from 'zod';

import { androidApiLevel, flag, linkage, name, oneOrMany, text, version } from './common.ts';

// configure's licence lists: gpl (EXTERNAL_LIBRARY_GPL_LIST), version3, gplv3 (needs both: gpl and version3) and nonfree
const FFMPEG_LICENSE_CLASSES = ['gpl', 'version3', 'gplv3', 'nonfree'] as const;
export type FfmpegLicenseClass = (typeof FFMPEG_LICENSE_CLASSES)[number];

const platforms = oneOrMany(
  text,
  'expected all, or a list of platform patterns like linux-* or win-x64',
);

/** A dependency: a recipe name, or `{ <name>: { platforms: [...] } }` for one only some platforms need. */
export interface Dep {
  name: string;
  platforms?: string[];
}
const dep = z.union(
  [
    name.transform((n): Dep => ({ name: n })),
    z
      .record(name, z.strictObject({ platforms: z.array(text).min(1) }))
      .refine((o) => Object.keys(o).length === 1, {
        error: 'each dependency names exactly one recipe',
      })
      .transform((o): Dep => {
        const [n, cond] = Object.entries(o)[0]!;
        return { name: n, platforms: cond.platforms };
      }),
  ],
  {
    error:
      'expected a recipe name, or one limited to platforms like `vulkan-shim: { platforms: [win-*] }`',
  },
);

/** The lists a built FFmpeg reports its components in: `ffmpeg -<kind>`, or the libraries' own lookups. */
export const SHIPPED_KINDS = [
  'encoders',
  'decoders',
  'filters',
  'hwaccels',
  'protocols',
  'muxers',
  'demuxers',
  'bsfs',
  'resamplers',
] as const;
export type ShippedKind = (typeof SHIPPED_KINDS)[number];

/** A component a built FFmpeg must report, and when: only with other options on too, or only on some platforms. */
export interface ShippedComponent {
  kind: ShippedKind;
  name: string;
  with?: string[];
  platforms?: string[];
}
// plain names only: they are passed to the smoke program on an Android device's shell
const componentName = z
  .string({ error: 'expected a component name' })
  .regex(/^[a-z0-9_-]+$/, { error: 'expected a component name like scale_vulkan or libx264' });
const shippedEntry = z.union(
  [
    componentName.transform((n) => ({ name: n })),
    z
      .record(
        componentName,
        z.strictObject({
          with: z.array(name).min(1).optional(),
          platforms: z.array(text).min(1).optional(),
        }),
      )
      .refine((o) => Object.keys(o).length === 1, { error: 'each entry names one component' })
      .transform((o) => {
        const [n, cond] = Object.entries(o)[0]!;
        return { name: n, ...cond };
      }),
  ],
  {
    error:
      'expected a component name, or one with conditions like `libplacebo: { with: [vulkan] }`',
  },
);
const ships = z
  .strictObject(
    Object.fromEntries(
      SHIPPED_KINDS.map((k) => [k, z.array(shippedEntry).min(1).optional()]),
    ) as Record<ShippedKind, z.ZodOptional<z.ZodArray<typeof shippedEntry>>>,
  )
  .transform((o): ShippedComponent[] =>
    SHIPPED_KINDS.flatMap((kind) => (o[kind] ?? []).map((e) => ({ kind, ...e }))),
  );

/** A recipe value only some platforms take: written `<value>`, or `{ <value>: { platforms: [...] } }`. */
interface PlatformValue {
  value: string;
  platforms?: string[];
}
function platformValue(value: z.ZodString, error: string) {
  return z.union(
    [
      value.transform((v): PlatformValue => ({ value: v })),
      z
        .record(value, z.strictObject({ platforms: z.array(text).min(1) }))
        .refine((o) => Object.keys(o).length === 1, { error: 'each entry names exactly one value' })
        .transform((o): PlatformValue => {
          const [v, cond] = Object.entries(o)[0]!;
          return { value: v, platforms: cond.platforms };
        }),
    ],
    { error },
  );
}

/** One option FFmpeg's configure offers, as recorded in ffmpeg/<major>.yml. */
const option = z
  .strictObject({
    builtin: flag.optional(),
    // its library: one recipe, or one per platform like [{ vulkan-loader: { platforms: [linux-*] } }, ...]; with
    // `builtin: true`, the platforms that need a library built (built in everywhere else)
    needs: z.union([name.transform((n): Dep[] => [{ name: n }]), z.array(dep).min(1)]).optional(),
    kind: text.optional(),
    since: version.optional(),
    min: version.optional(),
    'ffmpeg-license': z
      .enum(FFMPEG_LICENSE_CLASSES, { error: 'expected gpl, version3, gplv3 or nonfree' })
      .optional(),
    platforms: platforms.optional(),
    // the oldest Android API level a build with it can be made for (android-* targets' android-api:)
    'android-api': androidApiLevel.optional(),
    group: name.optional(),
    configure: z.array(text).optional(), // overrides the recipe's flags, for a library behind several options
    // what a build with the option on must report (ffmpeg -filters, -encoders, ...): `ffmpeg-build test` checks it
    ships: ships.optional(),
  })
  // built in (FFmpeg itself, or what the OS provides), a library, or both: built in where none of its per-platform
  // libraries applies (iconv: the C library's, and GNU libiconv where the C library has none)
  .refine(
    (o) =>
      o.builtin === true
        ? (o.needs ?? []).every((d) => d.platforms !== undefined)
        : o.needs !== undefined,
    {
      error:
        'an option is either `builtin: true` or `needs: <recipe>` (or a list per platform), not neither; with both, each library it needs names its platforms (built in on the others)',
    },
  );

export const ffmpegDataSchema = z.strictObject({
  major: z
    .string({ error: 'expected a major version' })
    .regex(/^\d+$/, { error: 'expected a major version like 9' }),
  releases: z.array(version).min(1),
  // the options whose components come with them: when a target lists a kind (components:), the components of it
  // that need one of these (the components file's needs:) are kept
  'auto-components': z.array(name).default([]),
  options: z.record(name, option),
});
export type FfmpegData = z.output<typeof ffmpegDataSchema>;

/** Where a library's versions come from: git tags, a branch head, or a release listing page. */
const versionsSchema = z.union(
  [
    z.strictObject({ 'git-tags': text, repo: text.optional() }),
    z.strictObject({ listing: text, files: text }),
    z.strictObject({ 'git-branch': text, repo: text.optional() }),
  ],
  {
    error:
      'expected one of: `git-tags: <regex>`, `listing: <url>` with `files: <regex>`, or `git-branch: <name>`',
  },
);

/**
 * A git source's submodules, fetched right after the checkout (`git submodule update --init ...`, retried): `true` for
 * all of them recursively, or `{ depth: 1, paths: [...] }` for a shallow fetch of some.
 */
export interface Submodules {
  recursive: boolean;
  depth?: number;
  paths: string[];
}
const submodules = z.union(
  [
    flag
      .refine((v) => v, { error: 'expected true, or { depth:, paths:, recursive: }' })
      .transform((): Submodules => ({ recursive: true, paths: [] })),
    z
      .strictObject({
        recursive: flag.default(false),
        depth: z
          .string()
          .regex(/^[1-9]\d*$/, { error: 'expected a depth like 1' })
          .transform(Number)
          .optional(),
        paths: z.array(text).default([]),
      })
      .transform((o): Submodules => ({
        recursive: o.recursive,
        paths: o.paths,
        ...(o.depth ? { depth: o.depth } : {}),
      })),
  ],
  { error: 'expected `submodules: true` or `submodules: { depth: 1, paths: [...] }`' },
);

/** Where a library's source comes from: a git repo checked out at `ref`, or a tarball (with fallbacks). */
const sourceSchema = z.union(
  [
    z.strictObject({
      git: text,
      ref: text.default('{version}'),
      mirror: text.optional(),
      submodules: submodules.optional(),
    }),
    z.strictObject({ url: text, mirrors: z.array(text).optional() }),
  ],
  {
    error:
      'expected `git: <url>` (with `ref:`, an optional `mirror:` and `submodules:`) or `url: <tarball url>` (with optional `mirrors:`)',
  },
);

/** A relative path that stays inside its folder: no leading /, no `..`, no backslashes. */
export const relativePath = text.refine(
  (p) =>
    !p.startsWith('/') &&
    !p.includes('\\') &&
    !p.split('/').some((s) => s === '..' || s === '.' || s === ''),
  {
    error: 'expected a relative path inside the folder, like COPYING or docs/FTL.TXT',
  },
);

/**
 * One licence file a library ships with: a path in its source (`COPYING`), or `{ recipe: <file> }` for a file kept
 * beside recipe.yml, for sources that have none (header-only drops).
 */
export interface LicenseFile {
  path: string;
  recipe?: true;
}
const licenseFile = z.union(
  [
    relativePath.transform((path): LicenseFile => ({ path })),
    z
      .strictObject({ recipe: relativePath })
      .transform((o): LicenseFile => ({ path: o.recipe, recipe: true })),
  ],
  {
    error:
      'expected a path in the source like COPYING, or `{ recipe: LICENSE }` for a file beside recipe.yml',
  },
);

// an environment variable's value (`+= ...` appends to the toolchain's); `unset:` lists the ones to remove
const buildEnv = z.record(text, z.string());
const unset = z.array(text).default([]);
// relative to the source, or under {src}, {deps} or a variable holding a path (a build checks it is inside the
// source or dependency folder when it runs)
const operationPath = text.refine(
  (p) => {
    if (
      /^(?:[A-Za-z]:)?[\\/]/.test(p) ||
      (p.startsWith('{') && !/^\{[A-Za-z_][A-Za-z0-9_-]*\}(?:\/|$)/.test(p))
    ) {
      return false;
    }
    const withoutRoot = p.replace(/^\{[A-Za-z_][A-Za-z0-9_-]*\}\/?/, '');
    if (!withoutRoot) {
      return p.startsWith('{');
    }
    return (
      !p.includes('\\') && !withoutRoot.split('/').some((s) => s === '..' || s === '.' || s === '')
    );
  },
  { error: 'expected a path inside {src} or {deps}, without `..` or backslashes' },
);

/** A recipe variable: a value, or a list (a list placeholder alone in an argument splices into several). */
const varName = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, { error: 'expected a variable name like cxx-libs' });
const vars = z.record(varName, z.union([z.string(), z.array(z.string())]));

/** When a step runs: all that are given must hold. */
const when = z
  .strictObject({
    platforms: z.array(text).min(1).optional(),
    exists: operationPath.optional(), // a path or glob that exists
    missing: operationPath.optional(), // a path or glob that matches nothing
    set: text.optional(), // text that is not empty once its placeholders are filled in
    unset: text.optional(),
  })
  .optional();

/** An edit to one field of a .pc file; `missing` says what to do when the file has no such line. */
export const PC_FIELDS = {
  libs: 'Libs',
  'libs-private': 'Libs.private',
  requires: 'Requires',
  'requires-private': 'Requires.private',
  cflags: 'Cflags',
} as const;
const pcFieldEdit = z
  .strictObject({
    append: text.optional(), // added at the end of the line, as given
    prepend: text.optional(), // added right after `Field:`
    add: text.optional(), // the words not already on the line (for Libs and Libs.private: on either) go at the end
    set: z.string().optional(), // the line becomes `Field: <set>`
    remove: text.optional(), // these words leave the line
    missing: z
      .enum(['end', 'after-libs', 'skip'], { error: 'expected end, after-libs or skip' })
      .default('end'),
  })
  .refine(
    (o) =>
      ['append', 'prepend', 'add', 'set', 'remove'].filter(
        (k) => o[k as keyof typeof o] !== undefined,
      ).length === 1,
    {
      error: 'give exactly one of append, prepend, add, set or remove',
    },
  );

const check = z
  .strictObject({
    exists: operationPath.optional(),
    missing: operationPath.optional(),
    file: operationPath.optional(), // with contains: (a substring) or line: (a whole line)
    contains: text.optional(),
    line: text.optional(),
    'ignore-case': flag.default(false),
    command: text.optional(), // a program on PATH
    output: z.array(text).min(1).optional(), // a command whose output must match `matches:`
    cwd: relativePath.optional(), // where output: runs, in the source (default: the source folder)
    matches: text.optional(),
    'min-version': version.optional(), // the first group of `matches:` is at least this version
    message: text,
  })
  .refine(
    (o) =>
      [o.exists, o.missing, o.file, o.command, o.output].filter((v) => v !== undefined).length ===
      1,
    {
      error: 'a check is exactly one of exists:, missing:, file:, command: or output:',
    },
  )
  .refine((o) => (o.file === undefined) === (o.contains === undefined && o.line === undefined), {
    error: 'file: needs contains: or line:',
  })
  .refine((o) => (o.output === undefined) === (o.matches === undefined), {
    error: 'output: needs matches:',
  });

const step = z.union([
  z.array(text).min(1),
  z.strictObject({
    run: z.array(text).min(1),
    env: buildEnv.default({}),
    unset,
    cwd: relativePath.optional(),
    when,
  }),
  z.strictObject({
    'replace-in-file': z.strictObject({
      path: operationPath,
      from: text,
      to: z.string(),
      regex: flag.default(false),
      optional: flag.default(false),
    }),
    when,
  }),
  z.strictObject({
    copy: z
      .strictObject({
        from: z
          .union([operationPath, z.array(operationPath).min(1)])
          .transform((v) => (Array.isArray(v) ? v : [v])),
        to: operationPath.optional(), // the copy's own path
        into: operationPath.optional(), // a folder the files go into
        recursive: flag.default(false),
        preserve: flag.default(false), // keep modification times, as cp -p
      })
      .refine((o) => (o.to === undefined) !== (o.into === undefined), {
        error: "give to: (the copy's path) or into: (a folder), not both",
      }),
    when,
  }),
  z.strictObject({ move: z.strictObject({ from: operationPath, to: operationPath }), when }),
  z.strictObject({ 'write-file': z.strictObject({ path: operationPath, text }), when }),
  z.strictObject({
    remove: z.strictObject({ path: operationPath, recursive: flag.default(false) }),
    when,
  }),
  z.strictObject({
    'pkg-config': z.strictObject({
      file: name.optional(), // {deps}/lib/pkgconfig/<file>.pc; default: name
      name: text,
      description: text,
      version: text,
      requires: text.optional(),
      libs: text.optional(), // after -L${libdir}
      'libs-private': text.optional(),
      cflags: text.optional(), // after -I${includedir}
      'exec-prefix': flag.default(false),
    }),
    when,
  }),
  z.strictObject({
    'edit-pkg-config': z.strictObject({
      path: operationPath,
      optional: flag.default(false), // a missing file is skipped
      ...(Object.fromEntries(
        Object.keys(PC_FIELDS).map((k) => [k, pcFieldEdit.optional()]),
      ) as Record<keyof typeof PC_FIELDS, z.ZodOptional<typeof pcFieldEdit>>),
    }),
    when,
  }),
  z.strictObject({ vars, when }),
  z.strictObject({
    find: z.strictObject({
      var: varName,
      glob: z
        .union([operationPath, z.array(operationPath).min(1)])
        .transform((v) => (Array.isArray(v) ? v : [v])),
      'ignore-case': flag.default(false),
      dirname: flag.default(false),
      basename: flag.default(false),
      required: text.optional(), // the message when nothing matches
    }),
    when,
  }),
  z.strictObject({
    read: z.strictObject({
      file: operationPath,
      pattern: text,
      var: varName,
      last: flag.default(false),
      message: text,
    }),
    when,
  }),
  z.strictObject({ check, when }),
  z.strictObject({
    'sync-shaderc-deps': flag.refine((v) => v, { error: 'expected true' }),
    when,
  }),
]);
export const RECIPES_ARE_DATA =
  'recipes are data: there are no shell: steps; write a command as a list, run:, or a declared operation (DEVELOPMENT.md, "Recipe format")';
// a step: a shell: step is turned away by name rather than as one more shape the union doesn't know
const buildStep = z
  .unknown()
  .superRefine((value, ctx) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'shell' in value) {
      ctx.addIssue({ code: 'custom', message: RECIPES_ARE_DATA });
    }
  })
  .pipe(step);
const buildAddition = z.strictObject({
  args: z.array(text).default([]),
  env: buildEnv.default({}),
  unset,
  vars: vars.default({}),
  before: z.array(buildStep).default([]),
  after: z.array(buildStep).default([]),
});
const bootstrap = z
  .union([text, z.array(text).min(1)])
  .transform((v) => (Array.isArray(v) ? v : [v]));
const recipeBuild = z
  .strictObject({
    system: z.enum(['cmake', 'meson', 'autotools', 'none']),
    args: z.array(text).default([]),
    'source-dir': relativePath.optional(),
    'source-inventory': relativePath.optional(),
    'configure-script': relativePath.default('configure'),
    'make-targets': z.array(text).default([]),
    'install-targets': z.array(text).default(['install']),
    // before everything else: autogen (./autogen.sh), autoreconf (autoreconf -fi) or a script in the source; a list
    // tries each in turn, quietly, until one works (the last one's output is shown)
    bootstrap: bootstrap.optional(),
    // a Rust library: the crates its Cargo.lock compiles in for the platform's Rust target, fetched after before:
    // and listed by cargo (package and features as the build selects them), go into THIRD-PARTY-NOTICES.txt and the
    // sources archive, and are checked against licenses.yml before the build; it then builds offline.
    // standard-texts: crates reviewed to take the standard text of their licence, as they ship no licence file.
    // exports: the library's C API (globs, as nm names them: rav1e_*); every other symbol its Rust objects define
    // takes the library's own prefix once it is built, so two Rust libraries link into one FFmpeg (build/rust-archive.ts)
    cargo: z
      .strictObject({
        target: text,
        package: text,
        features: z.array(text).default([]),
        'standard-texts': z.array(text).default([]),
        exports: z.array(z.string().regex(/^[\w.$*]+$/)).min(1),
      })
      .optional(),
    env: buildEnv.default({}),
    unset,
    vars: vars.default({}),
    platforms: z.record(text, buildAddition).default({}),
    steps: z.array(buildStep).default([]),
    before: z.array(buildStep).default([]),
    after: z.array(buildStep).default([]),
  })
  .refine((build) => build.system !== 'none' || build.steps.length > 0, {
    error: 'build.system: none needs at least one step',
  });

const runtimeFiles = z.array(
  platformValue(
    text.refine((g) => !g.startsWith('/') && !g.split('/').includes('..'), {
      error: 'expected a path inside the deps folder, like lib/libvulkan.so*',
    }),
    "expected a path inside the deps folder, like lib/libvulkan.so*, or one limited to platforms like `'lib/libvulkan*.dylib': { platforms: [osx-*] }`",
  ),
);
const linkMode = z.strictObject({
  vars: vars.default({}),
  runtime: runtimeFiles.optional(),
  platforms: platforms.optional(),
  packages: z.record(text, z.array(text)).default({}),
});

/** recipes/<name>/recipe.yml: facts about one library. Never a version. */
export const recipeSchema = z.strictObject({
  name,
  linkage: z
    .strictObject({
      default: linkage,
      modes: z.strictObject({
        static: linkMode.optional(),
        shared: linkMode.optional(),
        'system-shared': linkMode.optional(),
      }),
    })
    .refine((l) => l.modes[l.default] !== undefined, {
      error: 'linkage.modes must declare its default linking mode',
    })
    .optional(),
  provides: name.optional(), // the FFmpeg option this library is for; checked against ffmpeg/<major>.yml
  license: text, // SPDX expression; checked against profile licenses in a later step
  // the licence texts the archives carry in THIRD-PARTY-NOTICES.txt; a build fails when one is missing
  'license-files': z
    .array(licenseFile, { error: 'expected a list of licence files, like [COPYING]' })
    .min(1, { error: 'name at least one licence file' }),
  // FFmpeg's flags when this is its option's library; `{ <flag>: { platforms: [...] } }` for one some platforms need
  configure: z
    .array(
      platformValue(
        text,
        "expected a configure flag, or one limited to platforms like `'--extra-libs=-framework IOKit': { platforms: [maccatalyst-*] }`",
      ),
    )
    .default([]),
  needs: z.array(dep).default([]),
  uses: z.array(dep).default([]), // optional pieces, built in where the build's license and platform allow
  group: name.optional(),
  source: sourceSchema,
  versions: versionsSchema,
  // recipes released together (the Vulkan SDK's headers, loader and SPIR-V headers): the lock gives them one version
  'version-group': name.optional(),
  // the oldest Android API level it builds and links for (android-* targets' android-api: may not go lower)
  'android-api': androidApiLevel.optional(),
  notes: z.record(z.string(), text).optional(),
  // globs under DEPS_DIR that ship next to FFmpeg's libraries; relative and inside it; `{ <glob>: { platforms: [...] } }`
  // for one only some platforms ship
  runtime: runtimeFiles.optional(),
  build: recipeBuild,
  platforms,
});
export type Recipe = z.output<typeof recipeSchema>;

/** ffmpeg/source.yml: where FFmpeg's own versions come from. */
export const ffmpegSourceSchema = z.strictObject({
  git: text,
  versions: z.strictObject({ 'git-tags': text }),
  url: text,
  mirrors: z.array(text).default([]),
});

/** platforms.yml: what every build for a platform needs (toolchain image/definition and configure flags). */
export const platformsSchema = z.strictObject({
  platforms: z.record(
    text,
    z.strictObject({
      image: text,
      setup: name,
      runner: text.optional(), // the CI runner it builds on (default ubuntu-24.04)
      'test-runner': text.optional(), // the CI runner that runs its builds, when the one it builds on can't (default: runner)
      configure: z.array(text).optional(),
      // files the archives carry besides FFmpeg's and the recipes': name -> its SPDX licence and its notice file, a path
      // in the toolchain where ${VAR} is a variable of the platform's setup (its text goes into THIRD-PARTY-NOTICES.txt)
      ships: z
        .record(
          text,
          z.strictObject(
            { license: text, notice: text },
            { error: 'expected { license: <SPDX>, notice: <path of its licence text> }' },
          ),
        )
        .optional(),
    }),
  ),
});
interface Shipped {
  license: string;
  notice: string;
}
export interface PlatformEntry {
  image: string;
  setup: string;
  runner?: string;
  testRunner?: string;
  configure: string[];
  ships: Record<string, Shipped>;
}
