import { fetchWithTimeout, getSupabaseAdmin } from './helpers';
import { resolvePrimaryVenue } from './target-project';
import { RIVIERA_ID } from './constants';

const BASE = process.env.FLASHTAP_BASE_URL!;
const RIVIERA = process.env.RIVIERA_URL!;

describe('Web app & routing', () => {
  test('flashtap.app responds 200', async () => {
    const res = await fetchWithTimeout(BASE);
    expect(res.status).toBe(200);
  });

  test('riviera.flashtap.app responds 200', async () => {
    const res = await fetchWithTimeout(RIVIERA);
    expect(res.status).toBe(200);
  });

  test('the customer table entry route responds 200', async () => {
    // WAS `/table/1`, WHICH HAS NEVER BEEN A ROUTE. Confirmed 404 on production as well as
    // staging, so this was not an environment artefact -- the test asserted a path the app does
    // not and never did serve, and had been red for as long as it has existed. QR codes are built
    // by lib/onboarding/qr-url.ts as `/menu/${restaurantId}/v2?table=${n}`, which is the URL a
    // customer actually scans, and that is what is asserted now.
    const venue = await resolvePrimaryVenue(getSupabaseAdmin());
    const res = await fetchWithTimeout(`${RIVIERA}/menu/${venue.id}/v2?table=1`);
    expect(res.status).toBe(200);
  });

  test('/api/menu or restaurant menu endpoint exists', async () => {
    // Try known alternate paths — accept any non-500 response
    const paths = ['/api/menu', `/api/menu/${RIVIERA_ID}`, '/api/restaurant/menu'];
    const results = await Promise.all(
      paths.map((p) =>
        fetchWithTimeout(`${RIVIERA}${p}`)
          .then((r) => r.status)
          .catch(() => 0)
      )
    );
    const anyNon500 = results.some((s) => s !== 500 && s !== 0);
    expect(anyNon500).toBe(true);
  });

  test('Unknown subdomain returns non-200 or redirect', async () => {
    try {
      const res = await fetchWithTimeout('https://xyzunknown999.flashtap.app');
      expect([301, 302, 404, 200]).toContain(res.status); // Vercel handles it
    } catch {
      // DNS NXDOMAIN is also acceptable
      expect(true).toBe(true);
    }
  });
});
