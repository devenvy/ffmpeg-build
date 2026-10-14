import { defineConfig } from 'vitest/config';

// CLI tests spawn node and git, which is slow under load: longer timeouts than vitest's 5 s (tests) and 10 s (hooks:
// a beforeEach that builds local git repos and a server, as tests/upstream-helpers.ts makeScenario does).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json'],
      include: ['src/**/*.ts', 'scripts/**/*.ts'],
      // Code that runs only in a process the tests start, which coverage can't see: the CLI and its commands (the
      // tests run `ffmpeg-build ...` as users do), the build worker and what it alone runs (FFmpeg's build, staging, the notices; in
      // Docker or a native build), and the Apple bundle (lipo and xcodebuild, on a Mac). The tests still run all of it.
      // scripts/try-recipes.ts is a tool for building recipes by hand, in Docker.
      exclude: [
        'src/cli.ts',
        'src/commands/**',
        'src/build/worker.ts',
        'src/build/stage.ts',
        'src/build/notices.ts',
        'src/build/ffmpeg.ts',
        'src/bundle-apple.ts',
        'scripts/try-recipes.ts',
      ],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
