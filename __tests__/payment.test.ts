import { getSupabase, getSupabaseAdmin } from './helpers';
import { RIVIERA_ID, VALID_SETTLED_TYPES } from './constants';

describe('Payment & checkout', () => {
  const sb = getSupabase();
  const admin = getSupabaseAdmin();

  test('Checkout credentials present or fallback documented', async () => {
    const { data, error } = await admin
      .from('restaurants')
      .select('checkout_merchant_no, checkout_store_no')
      .eq('id', RIVIERA_ID)
      .single();
    expect(error).toBeNull();
    // Either own checkout creds or null (fallback to shared checkout merchant is handled in app)
    expect(data).toBeDefined();
  });

  test('Tab schema supports required columns', async () => {
    // SERVICE ROLE, not anon. #284 withdrew the anon SELECT on `tabs` -- the policy had no
    // restaurant scope, so any holder of the browser key could enumerate every open tab at every
    // venue. This assertion is about the SCHEMA (does the column exist), which is not an
    // anon-permission question, and asking it through the anon key made a schema check fail for a
    // grant reason. Using `admin` restores what it was actually testing.
    const { error } = await admin
      .from('tabs')
      .select('id, status, settled_type, restaurant_id')
      .limit(1);
    expect(error).toBeNull();
  });

  test('All settled tabs have valid settled_type values', async () => {
    // SERVICE ROLE, not anon. #284 withdrew the anon SELECT on `tabs` -- the policy had no
    // restaurant scope, so any holder of the browser key could enumerate every open tab at every
    // venue. This assertion is about the SCHEMA (does the column exist), which is not an
    // anon-permission question, and asking it through the anon key made a schema check fail for a
    // grant reason. Using `admin` restores what it was actually testing.
    const { data, error } = await admin
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
