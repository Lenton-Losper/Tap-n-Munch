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
  // `payments/*.js` are ESM with no `"type": "module"`, so Jest parsed them as CommonJS and
  // threw on the first `import`. Every existing suite worked around this by MOCKING
  // `@/payments/paycloud` rather than executing it — which is exactly why #171 (signing material
  // logged verbatim) survived four months with a green suite. Transforming .js lets a test
  // assert on what the real signing path actually does.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {}],
    '^.+\\.js$': ['ts-jest', { tsconfig: { allowJs: true, module: 'commonjs' } }],
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
}

export default config;
