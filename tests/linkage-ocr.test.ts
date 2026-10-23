import { describe, expect, it } from 'vitest';

import { loadEngineData } from '../src/engine-data.ts';
import { linkagePlan } from '../src/linkage.ts';
import { packageRoot } from '../src/paths.ts';

const data = loadEngineData(packageRoot);
const libraries = ['tesseract', 'leptonica', 'libpng', 'zlib'];

describe('OCR library linking ownership', () => {
  it('retains static defaults and requires a common shared pixel allocator for the shared OCR SDK', () => {
    const defaults = linkagePlan(data, libraries, 'linux-x64');
    expect(defaults.errors).toEqual([]);
    expect(defaults.modes['tesseract']).toBe('static');
    expect(defaults.modes['leptonica']).toBe('static');
    expect(linkagePlan(data, libraries, 'linux-x64', { tesseract: 'shared' }).errors).toHaveLength(
      1,
    );
    const choices: Record<string, 'shared'>[] = [
      { leptonica: 'shared' },
      { tesseract: 'shared', leptonica: 'shared' },
      { tesseract: 'shared', leptonica: 'shared', libpng: 'shared', zlib: 'shared' },
    ];
    for (const selected of choices) {
      expect(linkagePlan(data, libraries, 'linux-x64', selected).errors).toEqual([]);
    }
    expect(
      linkagePlan(data, libraries, 'linux-arm64', { leptonica: 'shared' }).errors,
    ).toHaveLength(1);
  });
});
