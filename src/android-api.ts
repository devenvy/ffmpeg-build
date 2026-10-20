// The Android API level an android-* build is compiled for: the oldest Android its libraries load on (an app's
// minSdk). 28 unless the target says `android-api:`; a lower level is checked against what the build's options and
// libraries need (ffmpeg/<major>.yml and recipe.yml `android-api:`): the C library's iconv and whisper.cpp's direct
// libvulkan link are Android 9 (API 28) APIs, so a build with them can't go lower.
import { type EngineData, optionsOf } from './engine-data.ts';

import type { CellPlan } from './resolve.ts';

/** The level an android build is made for when its target doesn't say: what the builds have always been. */
const ANDROID_API_DEFAULT = 28;

export const isAndroid = (platform: string): boolean => platform.startsWith('android-');

/** The level a build is made for: the target's `android-api:`, else the default. */
export const androidApiFor = (requested: number | undefined): number =>
  requested ?? ANDROID_API_DEFAULT;

/** What in a build needs a newer Android than the oldest: each option and library with an `android-api:` minimum. */
function androidApiNeeds(data: EngineData, cell: CellPlan): { what: string; api: number }[] {
  const options = optionsOf(data, cell.cell.major);
  return [
    ...cell.options.flatMap((o) => {
      const api = options.get(o)?.androidApi;
      return api ? [{ what: `option ${o}`, api }] : [];
    }),
    ...cell.recipes.flatMap((r) => {
      const api = data.recipes.get(r)?.['android-api'];
      return api ? [{ what: `library ${r}`, api }] : [];
    }),
  ];
}

/** Why a build can't be made for `requested`: each option or library that needs a newer Android, with its level. */
export function androidApiProblems(
  data: EngineData,
  cell: CellPlan,
  requested: number | undefined,
): string[] {
  if (requested === undefined || !isAndroid(cell.cell.platform)) {
    return [];
  }
  return androidApiNeeds(data, cell)
    .filter((n) => n.api > requested)
    .map(
      (n) =>
        `android-api: ${requested} is older than ${n.what} supports (API ${n.api}+): raise android-api: to ${n.api}, or build without it`,
    );
}
