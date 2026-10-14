// What a Mach-O file loads, read from `otool -L`: a universal (fat) file prints a header per architecture, which names
// the file itself and is not something it loads.
import { describe, expect, it } from 'vitest';

import { otoolLoads } from '../src/build/stage.ts';

describe('otoolLoads', () => {
  it('lists what a single-architecture file loads', () => {
    const out = [
      '/work/stage/run/libavcodec.62.dylib:',
      '\t@rpath/libavcodec.62.dylib (compatibility version 62.0.0, current version 62.28.103)',
      '\t@rpath/libavutil.60.dylib (compatibility version 60.0.0, current version 60.8.100)',
      '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)',
      '',
    ].join('\n');
    expect(otoolLoads(out)).toEqual([
      '@rpath/libavcodec.62.dylib',
      '@rpath/libavutil.60.dylib',
      '/usr/lib/libSystem.B.dylib',
    ]);
  });

  it("skips a universal file's architecture headers, and lists each load once", () => {
    const out = [
      '/work/stage/run/libMoltenVK.dylib (architecture x86_64):',
      '\t@rpath/libMoltenVK.dylib (compatibility version 1.0.0, current version 1.0.0)',
      '\t/System/Library/Frameworks/Metal.framework/Versions/A/Metal (compatibility version 1.0.0, current version 370.64.2)',
      '/work/stage/run/libMoltenVK.dylib (architecture arm64):',
      '\t@rpath/libMoltenVK.dylib (compatibility version 1.0.0, current version 1.0.0)',
      '\t/System/Library/Frameworks/Metal.framework/Versions/A/Metal (compatibility version 1.0.0, current version 370.64.2)',
    ].join('\r\n');
    expect(otoolLoads(out)).toEqual([
      '@rpath/libMoltenVK.dylib',
      '/System/Library/Frameworks/Metal.framework/Versions/A/Metal',
    ]);
  });
});
