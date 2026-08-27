/* eslint-env jest */
/**
 * #339 — the native stubs the APP TREE needs before it can be imported at all.
 *
 * The `eslint-env jest` directive above is not a suppression: the @react-native eslint config only
 * treats files under `__tests__/` as a Jest environment, and this file lives at the repo root
 * because that is where `jest.config.js` resolves `setupFiles` from. It genuinely runs inside Jest
 * and the `jest` global genuinely exists here.
 *
 * WHY THIS FILE EXISTS. `__tests__/App.test.tsx` imports App, which reaches AppNavigator ->
 * AuthContext -> lib/api -> constants, and `src/constants/index.ts:6` THROWS at module load if
 * `NativeModules.RuntimeConfig.API_BASE_URL` is unset. That guard is correct in production — a
 * build with no API base URL is misconfigured and should fail loudly — but in Jest there is no
 * native module, so importing any part of the app was fatal.
 *
 * That is why the individual lib suites each set `NativeModules.RuntimeConfig` by hand inside
 * `jest.isolateModulesAsync` (see payment.test.ts's header). That works for one module; it does
 * not work for a test that renders the whole app, because the throw happens during the import at
 * the top of the file, before any test body runs.
 *
 * ADDITIVE, NOT AUTHORITATIVE. Everything here is a default that a test file can still override:
 * `setupFiles` runs before the framework, and a `jest.mock()` in a suite takes precedence, as does
 * assigning `NativeModules.X` inside `isolateModulesAsync`. The existing suites keep doing exactly
 * what they did — they now just start from a working baseline instead of an empty one.
 *
 * THE VALUES ARE DELIBERATELY INVALID HOSTS. `example.invalid` is reserved by RFC 2606 and cannot
 * resolve, so if a test ever performs a real fetch it fails fast and visibly rather than reaching
 * a live environment. Nothing here may ever hold a real URL or a real key.
 */
const {NativeModules} = require('react-native');

/**
 * THE INVALID HOSTS ABOVE ARE NOT ENOUGH ON THEIR OWN — this is what makes them deterministic.
 *
 * `example.invalid` cannot resolve, so a stray fetch normally fails in about 100ms. But DNS is the
 * machine's, not ours: when the host's resolver stalls (this machine has an observed intermittent
 * happy-eyeballs/ETIMEDOUT condition) the same call hangs for tens of seconds instead of failing.
 * Every test that reaches the network then blows Jest's 5s default timeout AT ONCE, and the suite
 * reports as many failures as it has tests, with no assertion text — so it reads exactly like a
 * logic error in whatever was last changed.
 *
 * THAT IS NOT HYPOTHETICAL AND IT HAS ALREADY COST A SHIPPED FIX. orphanPaymentWiring.test.ts fails
 * 13/13 that way; the #344 hold-release fix was diagnosed as "its two-sided test would not go
 * green" and reverted out of vc99 on the strength of one such red. Reproduced deliberately by
 * stubbing a hanging fetch: identical signature, "Exceeded timeout of 5000 ms" on all 13.
 *
 * So the failure is made instant and local rather than left to the resolver. This is the SAME
 * intent the header states — a real fetch must fail fast and visibly — with the timing removed.
 * Additive like everything else here: a suite that wants its own fetch just assigns one.
 */
global.fetch = jest.fn(async (input) => {
  throw Object.assign(
    new TypeError(
      `fetch failed (jest.setup.js: no network in tests) for ${String(input)}`,
    ),
    {cause: {code: 'ENOTFOUND'}},
  );
});

NativeModules.RuntimeConfig = {
  API_BASE_URL: 'https://example.invalid',
  SUPABASE_URL: 'https://example.invalid',
  SUPABASE_ANON_KEY: 'test-anon-key',
  ENV_NAME: 'test',
  NOTIFY_URL: 'https://example.invalid/api/webhooks/paycloud',
  PAYCLOUD_APP_ID: 'test-app-id',
};

/** The card reader. Absent in Jest; suites that exercise payment flows install their own. */
NativeModules.PaymentModule = {
  launchPayment: jest.fn(),
  launchRefund: jest.fn(),
};

// Storage: both are native-backed and both are imported transitively by lib/api -> lib/storage.
jest.mock('react-native-encrypted-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
    clear: jest.fn(async () => undefined),
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));
