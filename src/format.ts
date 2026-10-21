import { versionInCell } from './choose.ts';
import { describePlatforms } from './platforms.ts';
import { isCommit, SHORT_COMMIT_LENGTH } from './ranges.ts';
import { seriesLabel } from './text.ts';

import type { ProfileReport } from './check.ts';
import type { EngineData } from './engine-data.ts';
import type { LockedProfile } from './lockfile.ts';
import type { Profile } from './profile.ts';
import type { ProfilePlan } from './resolve.ts';
import type { Linkage } from './schema/common.ts';

/** A report's problems as one line each ("pin: schannel: schannel is part of FFmpeg itself; ..."). */
export function problemLines(report: ProfileReport): string[] {
  return report.blocks.flatMap((block) =>
    block.lines
      .filter((line) => line.mark === '✗')
      .map((line) => [block.title, line.text, ...(line.detail ?? [])].filter(Boolean).join(': ')),
  );
}

/**
 * A report in short: one `✓` line when all is there, else its header and only its `✗` and `-` lines (with their
 * details). What `init` and `profile add/remove` print; `check` prints the whole report.
 */
export function formatSummary(report: ProfileReport): string {
  const shown = report.blocks.flatMap((block) =>
    block.lines.filter((line) => line.mark !== '✓').map((line) => ({ block, line })),
  );
  if (!shown.length) {
    return `✓ ${report.header}`;
  }
  const out = [`${report.problems ? '✗' : '-'} ${report.header}`];
  for (const { block, line } of shown) {
    out.push(
      `    ${line.mark} ${block.title ? `${block.title}: ` : ''}${line.text}${line.note ? `   (${line.note})` : ''}`,
    );
    for (const d of line.detail ?? []) {
      out.push(`        ${d}`);
    }
  }
  return out.join('\n');
}

export function formatReport(report: ProfileReport): string {
  const out = [report.header];
  for (const block of report.blocks) {
    const indent = block.title ? '    ' : '  ';
    if (block.title) {
      out.push(`  ${block.title}`);
    }
    for (const line of block.lines) {
      out.push(`${indent}${line.mark} ${line.text}${line.note ? `   (${line.note})` : ''}`);
      for (const d of line.detail ?? []) {
        out.push(`${indent}    ${d}`);
      }
    }
  }
  if (report.problems) {
    out.push(
      '',
      `${report.problems} problem${report.problems === 1 ? '' : 's'} in ${report.file}.`,
    );
  }
  return out.join('\n');
}

const shortVersionOf = (v: string) => (isCommit(v) ? v.slice(0, SHORT_COMMIT_LENGTH) : v);

export function formatPlan(
  profile: Profile,
  plan: ProfilePlan,
  data: EngineData,
  locked?: LockedProfile,
): string {
  const out = [profile.file];
  for (const v of plan.variants) {
    out.push(`  FFmpeg ${seriesLabel(v)} (${v.version}) · ${v.license}`);
    const rows = new Map<
      string,
      {
        platforms: string[];
        options: string[];
        recipes: string[];
        pins: Record<string, string>;
        linkages?: Record<string, Linkage>;
      }
    >();
    for (const c of plan.cells.filter(
      (cell) => cell.cell.series === v.series && cell.cell.license === v.license,
    )) {
      const libraries = c.recipes.map((r) =>
        locked
          ? `${r} ${shortVersionOf(versionInCell(profile, data, locked, c.cell, r) ?? '?')}`
          : r,
      );
      const key = JSON.stringify([c.options, libraries, c.pins, c.linkages]);
      const row = rows.get(key) ?? {
        platforms: [],
        options: c.options,
        recipes: libraries,
        pins: c.pins,
        ...(c.linkages ? { linkages: c.linkages } : {}),
      };
      row.platforms.push(c.cell.platform);
      rows.set(key, row);
    }
    for (const row of rows.values()) {
      out.push(`    ${describePlatforms(row.platforms)}`);
      out.push(`      options:   ${row.options.join(', ') || "(FFmpeg's built-ins only)"}`);
      out.push(`      libraries: ${row.recipes.join(', ') || '(none)'}`);
      if (row.linkages) {
        out.push(
          `      linking:   ${Object.entries(row.linkages)
            .map(([name, mode]) => `${name} ${mode}`)
            .join(', ')}`,
        );
      }
      const pinned = Object.entries(row.pins).map(([lib, ver]) => `${lib} ${ver}`);
      if (pinned.length) {
        out.push(`      pinned:    ${pinned.join(', ')}`);
      }
    }
  }
  return out.join('\n');
}

/** One profile's builds as `plan --json` prints them. */
export interface PlanJson {
  profile: string;
  file: string;
  builds: {
    ffmpeg: string;
    series: string;
    license: string;
    platform: string;
    options: string[];
    libraries: string[];
    pinned: Record<string, string>;
    linkages?: Record<string, Linkage>;
    versions?: Record<string, string>;
  }[];
}

export function planJson(
  profile: Profile,
  plan: ProfilePlan,
  data: EngineData,
  locked?: LockedProfile,
): PlanJson {
  return {
    profile: profile.name,
    file: profile.file,
    builds: plan.cells.map((c) => ({
      ffmpeg: c.cell.version,
      series: c.cell.series,
      license: c.cell.license,
      platform: c.cell.platform,
      options: c.options,
      libraries: c.recipes,
      pinned: c.pins,
      ...(c.linkages ? { linkages: c.linkages } : {}),
      ...(locked
        ? {
            versions: Object.fromEntries(
              c.recipes.map((r) => [r, versionInCell(profile, data, locked, c.cell, r) ?? '?']),
            ),
          }
        : {}),
    })),
  };
}
