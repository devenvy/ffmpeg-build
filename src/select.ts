// Choosing some of a folder's targets: `--target a,b` (names) and `--platform 'linux-*,win-*'` (platform patterns, as
// ffmpeg-build.yml writes them). Both together mean targets that match both. One file, a subset per machine or run.
import { FolderError } from './commands/folder.ts';
import { expandPlatformPattern } from './platforms.ts';
import { type Folder, FOLDER_FILE, type Target } from './targets.ts';

export interface Selection {
  target?: string;
  platform?: string;
}

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

/** The targets a selection names, in the file's order; every target when it names none. */
export function selectTargets(folder: Folder, sel: Selection): Target[] {
  let out = folder.targets;
  if (sel.target !== undefined) {
    const names = list(sel.target);
    if (!names.length) {
      throw new FolderError('--target: name at least one target');
    }
    const unknown = names.filter((n) => !folder.targets.some((t) => t.name === n));
    if (unknown.length) {
      throw new FolderError(
        `no target ${unknown.join(', ')} in ${FOLDER_FILE} (targets: ${folder.targets.map((t) => t.name).join(', ')})`,
      );
    }
    out = out.filter((t) => names.includes(t.name));
  }
  if (sel.platform !== undefined) {
    const patterns = list(sel.platform);
    if (!patterns.length) {
      throw new FolderError(
        '--platform: name at least one platform or pattern, e.g. linux-*,win-x64',
      );
    }
    const bad = patterns.filter((p) => !expandPlatformPattern(p).length);
    if (bad.length) {
      throw new FolderError(`--platform: ${bad.join(', ')} names no platform ffmpeg-build knows`);
    }
    const wanted = new Set(patterns.flatMap(expandPlatformPattern));
    out = out.filter((t) => wanted.has(t.platform));
  }
  if (!out.length) {
    const asked = [
      sel.target !== undefined ? `--target ${sel.target}` : '',
      sel.platform !== undefined ? `--platform ${sel.platform}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    throw new FolderError(
      `no target matches ${asked} (targets: ${folder.targets.map((t) => `${t.name} (${t.platform})`).join(', ')})`,
    );
  }
  return out;
}

/** The selected names as the commands' `target` option takes them (comma-separated), or nothing for every target. */
export function selectedNames(folder: Folder, sel: Selection): { target?: string } {
  if (sel.target === undefined && sel.platform === undefined) {
    return {};
  }
  return {
    target: selectTargets(folder, sel)
      .map((t) => t.name)
      .join(','),
  };
}
