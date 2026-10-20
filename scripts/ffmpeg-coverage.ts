// What the engine supports of what FFmpeg's configure offers: node scripts/ffmpeg-coverage.ts [--issue]
// Without --issue: each FFmpeg major's counts (offered, supported, pending, not planned) and every problem the coverage
// gate (tests/ffmpeg-coverage.test.ts) fails on, exiting 1 when there is one.
// --issue: ffmpeg/unsupported.yml's pending entries as a markdown checklist, by batch (issue #21's), then the rest.
import { loadEngineData } from '../src/engine-data.ts';
import {
  coverage,
  formatCounts,
  formatCoverage,
  issueChecklist,
  readCoverageData,
} from '../src/ffmpeg-coverage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const { offered, unsupported } = readCoverageData(data);
if (process.argv.includes('--issue')) {
  process.stdout.write(issueChecklist(unsupported));
} else {
  const { problems, counts } = coverage(data, offered, unsupported);
  process.stdout.write(formatCounts(counts));
  if (problems.length) {
    process.stdout.write(`\n${formatCoverage(problems)}`);
    process.exitCode = 1;
  }
}
