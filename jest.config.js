module.exports = {
  preset: '@react-native/jest-preset',
  /**
   * #339. `@react-navigation/*` ships ESM only, and the preset's own allowlist does not include it,
   * so `import App from '../App'` died on `SyntaxError: Unexpected token 'export'` inside
   * @react-navigation/native. __tests__/App.test.tsx has therefore NEVER RUN — it reported
   * `Tests: 0 total` as a suite that failed to LOAD, which is not the same thing as a failing
   * assertion and is far easier to leave sitting in a baseline for months.
   *
   * EXTENDED FROM THE PRESET'S OWN PATTERN, not replaced. The preset ships
   *   'node_modules/(?!((jest-)?react-native|@react-native(-community)?)/)'
   * and dropping any of those arms to add a new one would silently stop transforming
   * `jest-react-native` and `@react-native-community/*`. Every arm below is the preset's except
   * the last two, which are the packages this app actually imports that publish ESM.
   *
   * The list is deliberately explicit rather than a blanket `react-native-.*`: every package added
   * here is one more that babel must transform on every run, and a blanket pattern hides which
   * dependency needed it and why.
   */
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|@react-navigation|react-native-vector-icons|react-native-qrcode-svg|react-native-svg)/)',
  ],
  /**
   * #339. The preset's own setup MUST be listed explicitly: naming `setupFiles` here REPLACES the
   * preset's array rather than appending to it, so omitting the first entry would silently
   * uninstall React Native's own Jest setup for every suite.
   */
  setupFiles: [
    require.resolve('@react-native/jest-preset/jest/setup.js'),
    '<rootDir>/jest.setup.js',
  ],
  /**
   * #340's lesson, made structural. A non-test file sitting in `__tests__/` is DISCOVERED as a
   * suite and reported as "must contain at least one test" — a permanent red that gets explained
   * away in briefs rather than fixed, which is exactly what runStaffApiErrors.ts did for months.
   * Shared harnesses now live in `__tests__/helpers/` and are ignored as suites, so adding one can
   * never reintroduce that phantom failure.
   */
  testPathIgnorePatterns: ['/node_modules/', '/__tests__/helpers/'],
};
