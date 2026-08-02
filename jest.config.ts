import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: [require.resolve('./jest.setup-env.ts')],
  // .tsx so component behaviour can be asserted directly; such files opt into jsdom with a
  // `@jest-environment jsdom` docblock (the default stays node, which the rest rely on).
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  testTimeout: 15000,
  maxWorkers: 1,
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
}

export default config;
