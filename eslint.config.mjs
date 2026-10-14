import { createConfig } from '@devenvy/code-guidelines/eslint';

export default createConfig({
  rootDir: import.meta.dirname,
  env: 'node',
  vitest: true,
});
