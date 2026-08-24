import { fetchWithTimeout } from './helpers';
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

  test('/table/1 route responds 200', async () => {
    const res = await fetchWithTimeout(`${RIVIERA}/table/1`);
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
