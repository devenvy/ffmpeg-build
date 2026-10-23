// A build's outputs in --out: its archives (and a win-x64 build's debug symbols), <name>.sources.json, the
// <name>.sources/ folder and its log. A build writes them into a staging folder of its own inside --out (the same
// filesystem, so moves are renames; Docker mounts it as /out), and they replace the previous set only when the build
// succeeded. A per-artifact lock keeps two builds of the same artifact into the same --out apart.
//
// The swap is journalled, so a run that dies at any step leaves something the next run can finish or undo:
// 1. `.<name>.swap-<id>.json` is written (atomically) naming exactly the items of the old set in --out and of the new
//    set in staging, with `committed: false`;
// 2. the old items move into `.<name>.previous-<id>`, then the new items move in from `.<name>.staging-<id>`;
// 3. the journal is rewritten with `committed: true`;
// 4. the staging folder, the previous set and the journal are removed.
// Recovery (the next run, under the same lock) reads the journal. Committed: it only removes what step 4 hadn't.
// Not committed: each new item that had moved in is removed (an item still in staging hadn't, so what --out has under
// that name is the old one), the old items move back, and staging, previous and journal go. So --out ends with the
// whole old set (nothing, on a first build) or the whole new one, never a mix or a lone new artifact.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, join } from 'node:path';

import { writeDurably } from './atomic-write.ts';
import { acquireLock, type HeldLock } from './file-lock.ts';
import { readPlainFile } from './read-file.ts';
import { symbolsName } from './targets.ts';

/** The files and folder of an artifact's set, the log included. */
const artifactItems = (name: string): string[] => [
  `${name}.tar.gz`,
  `${name}-dev.tar.gz`,
  symbolsName(name),
  `${name}.sources.json`,
  `${name}.sources`,
  `${name}.log`,
];

export interface OutputSet {
  /** Where the build writes: a fresh folder inside --out. */
  readonly staging: string;
  /** The build's log, in the staging folder. */
  readonly log: string;
  /** The build succeeded: the staged set replaces the previous one. */
  commit: () => void;
  /** The build failed: the previous set stays; the failed build's log replaces the previous log. */
  abort: () => void;
  release: () => void;
}

/** Test hooks: `afterStep` is called after each step of a swap; throwing from it stands for the process dying there. */
export interface OutputHooks {
  afterStep?: (step: string) => void;
  /** Injects journal replacement failures while retaining real artifact moves. */
  renameJournal?: (from: string, to: string) => void;
}

interface Journal {
  old: string[];
  new: string[];
  committed: boolean;
}

const swapFiles = (out: string, name: string, id: string) => ({
  journal: join(out, `.${name}.swap-${id}.json`),
  previous: join(out, `.${name}.previous-${id}`),
  staging: join(out, `.${name}.staging-${id}`),
});

const JOURNAL_ATTEMPTS = 8;
const JOURNAL_RETRY_MS = 50;
const JOURNAL_SHARING_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);
const JOURNAL_PAUSE = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function writeJournal(
  path: string,
  journal: Journal,
  rename: (from: string, to: string) => void = renameSync,
): void {
  const temp = `${path}.tmp`;
  rmSync(temp, { force: true });
  writeDurably(temp, `${JSON.stringify(journal)}\n`);
  // Windows scanners can briefly deny replacement of the closed journal. Keep
  // its old bytes intact until the atomic rename succeeds; a permanent failure
  // still reaches the existing whole-set rollback after at most 350 ms.
  for (let attempt = 1; ; attempt++) {
    try {
      rename(temp, path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === JOURNAL_ATTEMPTS || !code || !JOURNAL_SHARING_ERRORS.has(code)) {
        throw error;
      }
      Atomics.wait(JOURNAL_PAUSE, 0, 0, JOURNAL_RETRY_MS);
    }
  }
}

/**
 * A swap journal, when it is one: every item it names must be one of the artifact's own (a swap moves only those), so a
 * journal anyone left in --out can't point removal or renames at anything else.
 */
/** A journal is a few names; anything larger isn't one. */
const MAX_JOURNAL_BYTES = 65_536; // 64 KiB

function readJournal(path: string, items: readonly string[]): Journal | undefined {
  // each of the artifact's own names, at most once (a real journal never repeats one)
  const own = (list: unknown) =>
    Array.isArray(list) &&
    new Set(list).size === list.length &&
    list.every((item) => typeof item === 'string' && items.includes(item));
  try {
    // a plain, small file: never followed through a link, or read from a device or FIFO
    const text = readPlainFile(path, { maxBytes: MAX_JOURNAL_BYTES, noFollow: true });
    if (text === undefined) {
      return undefined;
    }
    const j = JSON.parse(text) as Journal;
    if (own(j.old) && own(j.new) && typeof j.committed === 'boolean') {
      return j;
    }
  } catch {
    // unreadable: treated as absent below
  }
  return undefined;
}

function moveItems(
  from: string,
  to: string,
  items: readonly string[],
  step?: (s: string) => void,
): string[] {
  const moved: string[] = [];
  for (const item of items) {
    if (existsSync(join(from, item))) {
      renameSync(join(from, item), join(to, item));
      moved.push(item);
      step?.(item);
    }
  }
  return moved;
}

/** Finishes or undoes the journalled swap `id` (see the top of this file). */
function settleSwap(out: string, name: string, id: string, journal: Journal): void {
  const f = swapFiles(out, name, id);
  if (!journal.committed) {
    for (const item of journal.new) {
      if (!existsSync(join(f.staging, item))) {
        rmSync(join(out, item), { recursive: true, force: true });
      } // it had moved in
    }
    if (existsSync(f.previous)) {
      moveItems(
        f.previous,
        out,
        journal.old.filter((item) => !existsSync(join(out, item))),
      );
    }
  }
  rmSync(f.staging, { recursive: true, force: true });
  rmSync(f.previous, { recursive: true, force: true });
  rmSync(f.journal, { force: true });
}

/** Puts back, or finishes, what a run that died left for this artifact in --out. */
function recover(out: string, name: string): void {
  const items = artifactItems(name);
  const prefix = `.${name}.`;
  const leftovers = () => readdirSync(out).filter((f) => f.startsWith(prefix));
  for (const f of leftovers().filter(
    (x) => x.startsWith(`${prefix}swap-`) && x.endsWith('.json.tmp'),
  )) {
    rmSync(join(out, f), { force: true });
  }
  for (const f of leftovers().filter(
    (x) => x.startsWith(`${prefix}swap-`) && x.endsWith('.json'),
  )) {
    const id = f.slice(`${prefix}swap-`.length, -'.json'.length);
    const journal = readJournal(join(out, f), items);
    if (journal) {
      settleSwap(out, name, id, journal);
    }
    // not a journal: written atomically, so never half, and nothing moved under it. Only a plain file (or a link) of
    // that name is removed; a folder or anything else is left alone.
    else if (!lstatSync(join(out, f)).isDirectory()) {
      rmSync(join(out, f), { force: true });
    }
  }
  // a swap from before journals: its previous folder (made before anything moved) beside its staging folder means
  // the move-in hadn't finished. Every old item had moved aside, so whatever of the artifact --out shows came from
  // the unfinished new set: it all goes, and the previous set (none, on a first build) comes back. A staging folder
  // without a previous folder is a build that died before any swap began: --out still has the old set.
  for (const previous of leftovers().filter((f) => f.startsWith(`${prefix}previous-`))) {
    const id = previous.slice(`${prefix}previous-`.length);
    const staging = join(out, `${prefix}staging-${id}`);
    if (existsSync(staging)) {
      for (const item of items) {
        rmSync(join(out, item), { recursive: true, force: true });
      }
      moveItems(join(out, previous), out, items);
    }
    rmSync(join(out, previous), { recursive: true, force: true });
  }
  for (const staging of leftovers().filter((f) => f.startsWith(`${prefix}staging-`))) {
    rmSync(join(out, staging), { recursive: true, force: true });
  }
}

/** The process "died" at a step (a test hook threw): nothing more runs, as after a real crash. */
class Died extends Error {}

/**
 * Takes the artifact's lock in `out` (LockBusyError when another build of it is writing there), tidies what a crashed
 * run left, and makes the staging folder.
 */
export function beginOutputs(out: string, name: string, hooks: OutputHooks = {}): OutputSet {
  mkdirSync(out, { recursive: true });
  const lock: HeldLock = acquireLock(
    join(out, `.${name}.lock`),
    `the outputs of ${name} in ${out}`,
  );
  let staging: string;
  try {
    recover(out, name);
    staging = mkdtempSync(join(out, `.${name}.staging-`));
  } catch (e) {
    lock.release();
    throw e;
  }
  const id = basename(staging).slice(`.${name}.staging-`.length);
  const items = artifactItems(name);
  const log = join(staging, `${name}.log`);
  // a swap that died, or failed and couldn't be undone, leaves its journal and folders for the next run's recover()
  let keepStaging = false;
  const dropStaging = () => {
    if (!keepStaging) {
      rmSync(staging, { recursive: true, force: true });
    }
  };
  const step = (s: string) => {
    try {
      hooks.afterStep?.(s);
    } catch (e) {
      throw new Died('died', { cause: e });
    }
  };
  return {
    staging,
    log,
    commit() {
      const f = swapFiles(out, name, id);
      const journal: Journal = {
        old: items.filter((i) => existsSync(join(out, i))),
        new: items.filter((i) => existsSync(join(staging, i))),
        committed: false,
      };
      try {
        writeJournal(f.journal, journal, hooks.renameJournal);
        step('journal');
        mkdirSync(f.previous);
        moveItems(out, f.previous, journal.old, (i) => step(`aside:${i}`));
        moveItems(staging, out, journal.new, (i) => step(`in:${i}`));
        writeJournal(f.journal, { ...journal, committed: true }, hooks.renameJournal);
        step('moved-in');
      } catch (e) {
        if (e instanceof Died) {
          keepStaging = true;
          throw e.cause;
        }
        let rolledBack = true;
        try {
          settleSwap(out, name, id, readJournal(f.journal, artifactItems(name)) ?? journal);
        } catch {
          rolledBack = false;
          keepStaging = true;
        }
        throw new Error(
          `couldn't move the new ${name} into ${out} (${(e as Error).message}); ${rolledBack ? 'the previous one is back in place' : `couldn't put the previous one back either: it is in ${f.previous}, and the next build of it puts it back`}`,
          { cause: e },
        );
      }
      try {
        rmSync(staging, { recursive: true, force: true });
        step('staging-removed');
        rmSync(f.previous, { recursive: true, force: true });
        step('previous-removed');
        rmSync(f.journal, { force: true });
        step('done');
      } catch (e) {
        keepStaging = true; // committed: the next run finishes the clean-up
        throw e instanceof Died ? e.cause : e;
      }
    },
    abort() {
      if (keepStaging) {
        return;
      }
      if (existsSync(log)) {
        rmSync(join(out, `${name}.log`), { force: true });
        renameSync(log, join(out, `${name}.log`));
      }
      dropStaging();
    },
    /** Removes the staging folder if neither commit nor abort did, then the lock. */
    release() {
      dropStaging();
      lock.release();
    },
  };
}
