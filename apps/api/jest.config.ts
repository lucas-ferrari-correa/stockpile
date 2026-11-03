import type { Config } from 'jest';

const config: Config = {
  rootDir: '.',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  globalSetup: '<rootDir>/test/support/global-setup.ts',
  setupFiles: ['<rootDir>/test/support/setup-env.ts'],
  testEnvironment: 'node',
};

export default config;
