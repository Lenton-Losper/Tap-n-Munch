import { fetchWithTimeout } from './helpers';
import { RIVIERA_ID } from './constants';

const BASE = process.env.FLASHTAP_BASE_URL ?? 'https://flashtap.app';

describe('Permission enforcement', () => {

  test('GET /api/menu/[restaurantId]/features returns 200 without auth (public)', async () => {
    const res = await fetchWithTimeout(`${BASE}/api/menu/${RIVIERA_ID}/features`);
    expect(res.status).toBe(200);
  });

  test('GET /api/admin/features returns 401 without auth token', async () => {
    const res = await fetch(`${BASE}/api/admin/features`);
    expect([401, 403]).toContain(res.status);
  });

  test('GET /api/platform/restaurants returns 401 without auth token', async () => {
    const res = await fetch(`${BASE}/api/platform/restaurants`);
    expect([401, 403]).toContain(res.status);
  });

  test('PATCH /api/platform/restaurants/[id]/features returns 401 without auth', async () => {
    const res = await fetch(`${BASE}/api/platform/restaurants/${RIVIERA_ID}/features`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kiosk_enabled: true }),
    });
    expect([401, 403]).toContain(res.status);
  });

  test('PATCH /api/admin/menu/items returns 401 without auth token', async () => {
    const res = await fetch(`${BASE}/api/admin/menu/items`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hacked' }),
    });
    expect([401, 403]).toContain(res.status);
  });

  test('GET /api/admin/staff returns 401 without auth token', async () => {
    const res = await fetch(`${BASE}/api/admin/staff`);
    expect([401, 403]).toContain(res.status);
  });

  test('POST /api/admin/restaurant-settings returns 401 without auth token', async () => {
    const res = await fetch(`${BASE}/api/admin/restaurant-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantId: RIVIERA_ID,
        updates: { name: 'Hacked' },
      }),
    });
    expect([401, 403]).toContain(res.status);
  });

  test('GET /api/admin/restaurants/[id]/report-schedules returns 401 without auth token', async () => {
    const res = await fetch(`${BASE}/api/admin/restaurants/${RIVIERA_ID}/report-schedules`);
    expect([401, 403]).toContain(res.status);
  });
});
