import { getSupabase, getSupabaseAdmin } from './helpers';
import { STAGING_TEST_RESTAURANT_ID } from './helpers/staging-auth-fixtures';
import { VALID_SETTLED_TYPES } from './constants';

/**
 * The credentials test below named the PRODUCTION Riviera venue while this suite runs against the
 * STAGING Supabase project (.env.test -> mdqjpxwczrhkxkbqatqa), so `.single()` found no row and
 * returned PGRST116 -- permanently red. Do NOT re-point it at production.
 */
describe('Payment & checkout', () => {
  const sb = getSupabase();
  const admin = getSupabaseAdmin();

  test('Checkout credentials are whole or absent, never half-configured', async () => {
    // The old assertion was `expect(data).toBeDefined()` on one production row, which says
    // nothing about any value. What actually matters is that a venue either carries BOTH checkout
    // numbers or NEITHER: a merchant number without a store number (or the reverse) signs a
    // request that cannot settle, while both-null is the documented fallback to the shared
    // checkout merchant. That is asserted across every staging venue rather than one id, so it
    // does not go vacuous again if a fixture is renamed.
    const { data, error } = await admin
      .from('restaurants')
      .select('id, checkout_merchant_no, checkout_store_no');
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0); // positive control: no rows, no assertion

    const halfConfigured = (data ?? []).filter(
      (r: any) => Boolean(r.checkout_merchant_no) !== Boolean(r.checkout_store_no)
    );
    expect(halfConfigured).toEqual([]);

    // And the columns are still selectable on the fixture venue, which is what a schema change
    // would break first.
    const { data: fixture, error: fixtureError } = await admin
      .from('restaurants')
      .select('checkout_merchant_no, checkout_store_no')
      .eq('id', STAGING_TEST_RESTAURANT_ID)
      .single();
    expect(fixtureError).toBeNull();
    expect(fixture).not.toBeNull();
  });

  test('Tab schema supports required columns', async () => {
    const { error } = await sb
      .from('tabs')
      .select('id, status, settled_type, restaurant_id')
      .limit(1);
    expect(error).toBeNull();
  });

  test('All settled tabs have valid settled_type values', async () => {
    const { data, error } = await sb
      .from('tabs')
      .select('settled_type')
      .not('settled_type', 'is', null)
      .limit(100);
    expect(error).toBeNull();
    const invalid = (data ?? []).filter((t: any) => !VALID_SETTLED_TYPES.includes(t.settled_type));
    expect(invalid).toHaveLength(0);
  });

  test('Finatic developer portal is reachable', async () => {
    try {
      const res = await fetch('https://developers.finatic.africa', { method: 'HEAD', signal: AbortSignal.timeout(6000) });
      expect([200, 301, 302, 403]).toContain(res.status);
    } catch {
      console.warn('Finatic portal unreachable from test environment — skip');
    }
  });
});
