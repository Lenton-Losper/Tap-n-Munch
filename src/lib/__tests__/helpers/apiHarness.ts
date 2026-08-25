/**
 * Shared harness for suites that assert what api.ts puts ON THE WIRE.
 *
 * WHY IT IS SHARED. Two suites need it — apiPaymentContract (#327/#328) and
 * strandedRequestRelease (#120) — and when both carried their own copy, neither file had a
 * top-level import, so TypeScript treated them as global scripts and their identical `FetchCall`
 * and `withApi` declarations collided at the global scope. `tsc` failed with TS2300/TS2393 even
 * though every test passed. Extracting the harness fixes the duplication and the module-scope
 * problem in one move.
 *
 * WHY IT LIVES UNDER `helpers/`. jest.config ignores that directory, because a non-test file
 * discovered as a suite is reported as "must contain at least one test" — which is exactly the
 * permanent phantom failure #340 existed to remove. Adding a helper here without that ignore
 * would have reintroduced it.
 *
 * api.ts reads NativeModules.RuntimeConfig at module load and pulls in ./storage ->
 * react-native-encrypted-storage transitively, so it is required fresh inside
 * jest.isolateModulesAsync with the natives stubbed.
 */
export type FetchCall = {url: string; init: RequestInit};

/**
 * Load api.ts against a stubbed fetch that returns one canned response, and hand the caller both
 * the module and the calls it made.
 */
export async function withApi<T>(
  respondWith: {status: number; body: unknown},
  run: (api: typeof import('../../api'), calls: FetchCall[]) => Promise<T>,
): Promise<T> {
  let out!: T;
  await jest.isolateModulesAsync(async () => {
    const {NativeModules} = require('react-native');
    NativeModules.RuntimeConfig = {
      API_BASE_URL: 'https://example.invalid',
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_ANON_KEY: 'test',
      ENV_NAME: 'test',
    };

    const calls: FetchCall[] = [];
    (globalThis as {fetch?: unknown}).fetch = jest.fn(
      async (url: string, init: RequestInit) => {
        calls.push({url, init});
        const text = JSON.stringify(respondWith.body);
        return {
          ok: respondWith.status >= 200 && respondWith.status < 300,
          status: respondWith.status,
          headers: {get: () => null},
          json: async () => JSON.parse(text),
          text: async () => text,
          clone: () => ({text: async () => text}),
        };
      },
    );

    const api = require('../../api') as typeof import('../../api');
    out = await run(api, calls);
  });
  return out;
}
