import { fetchWithTimeout } from './helpers';
import { STAGING_TEST_RESTAURANT_ID } from './helpers/staging-auth-fixtures';

/**
 * READ BEFORE ADDING A HOSTNAME HERE.
 *
 * `.env.test` deliberately points both FLASHTAP_BASE_URL and RIVIERA_URL at the STAGING worker
 * (https://flashtap-staging.llosperofficial.workers.dev). RIVIERA_URL is NOT riviera.flashtap.app
 * -- that hostname is PRODUCTION. Anything in this file that needs the real Riviera subdomain to
 * answer is testing production from the staging suite, and does not belong here.
 */
const BASE = process.env.FLASHTAP_BASE_URL!;
const RIVIERA = process.env.RIVIERA_URL!;

describe('Web app & routing', () => {
  test('flashtap.app responds 200', async () => {
    const res = await fetchWithTimeout(BASE);
    expect(res.status).toBe(200);
  });

  test('the RIVIERA_URL host responds 200', async () => {
    // Renamed from 'riviera.flashtap.app responds 200'. Under .env.test this resolves to the same
    // staging worker as BASE, so the old name described a request this suite never makes.
    const res = await fetchWithTimeout(RIVIERA);
    expect(res.status).toBe(200);
  });

  // DELETED: '/table/1 route responds 200'. The /table/N rewrite is gated on an EXACT host match
  // for riviera.flashtap.app (lib/riviera-subdomain.ts `isRivieraHost`, applied in middleware.ts),
  // so `${RIVIERA}/table/1` against the staging worker 404s and that 404 is CORRECT. Measured:
  // staging worker /table/1 -> 404; the same request with a `Host: riviera.flashtap.app` header ->
  // 403, because Cloudflare rejects the host mismatch before the worker runs, so there is no way
  // to exercise the rewrite against staging over HTTP. The only URL that answers 200 is
  // production. The rewrite itself is already covered offline, with positive controls, by
  // __tests__/table-landing-routing.test.ts, which drives the real middleware with a real
  // NextRequest carrying the Riviera host.

  test('the menu features endpoint serves the fixture venue', async () => {
    // Was: fetch '/api/menu', `/api/menu/${RIVIERA_ID}` and '/api/restaurant/menu' and pass if any
    // returned anything other than 500. All three are 404 on the deployed worker, and a 404 is not
    // a 500, so the test passed while proving only that the worker replies at all -- and it named a
    // production restaurant id. `/api/menu/{restaurantId}/features` is a route that really exists
    // (app/api/menu/[restaurantId]/features/route.ts) and needs no terminal token, unlike the
    // sibling /categories route which 401s. It answers 200 with `{features: null}` for an unknown
    // id, so the venue in the payload is what makes this assertion discriminating.
    const res = await fetchWithTimeout(`${RIVIERA}/api/menu/${STAGING_TEST_RESTAURANT_ID}/features`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.features).not.toBeNull();
    expect(body.features.restaurant_id).toBe(STAGING_TEST_RESTAURANT_ID);
  });

  // DELETED: 'Unknown subdomain returns non-200 or redirect'. It could not fail: it accepted
  // 301, 302, 404 AND 200 -- every status the host could plausibly return -- and its catch branch
  // asserted `expect(true).toBe(true)`, so a DNS failure passed too. It also resolved a
  // *.flashtap.app hostname, i.e. production DNS, from a suite pinned to staging.
});
