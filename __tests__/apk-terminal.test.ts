import { getSupabase, getSupabaseAdmin } from './helpers';
import { STAGING_TEST_RESTAURANT_ID } from './helpers/staging-auth-fixtures';

/**
 * This suite named the PRODUCTION Riviera venue while running against the STAGING Supabase
 * project (.env.test -> mdqjpxwczrhkxkbqatqa), which has no such row. Two tests were permanently
 * red and the rest passed over an empty result set. Do NOT re-point any of it at production.
 *
 * DELETED: 'Riviera has finatic_terminal_sn set' and 'Riviera terminal SN matches P5 or dev
 * phone'. Both are assertions about PHYSICAL PRODUCTION HARDWARE -- that a particular live venue
 * has a terminal paired, and that its serial is one of two specific devices (the P5 or the dev
 * phone). ZERO staging venues have finatic_terminal_sn set, and staging has no paired hardware to
 * point them at, so there is no version of either test that means anything here. Pairing a fake
 * serial onto a staging row just to read it back would assert only that the column round-trips.
 * P5_TERMINAL_SN / DEV_PHONE_SN remain exported from ./constants for anything that checks the
 * terminal repo itself.
 */
describe('APK & terminal logic', () => {
  const sb = getSupabase();
  const admin = getSupabaseAdmin();

  test('Orders have a timestamp column', async () => {
    const { error } = await sb.from('orders').select('placed_at').limit(1);
    expect(error).toBeNull();
    // placed_at is the available timestamp; created_at/updated_at do not exist in prod schema
  });

  test('All fixture venue order statuses are valid', async () => {
    // Service role, not anon: staging RLS hides `orders` from the anon key entirely, so the anon
    // version of this returned zero rows and validated an empty list no matter what was stored.
    const { data, error } = await admin
      .from('orders')
      .select('status')
      .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
      .limit(200);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0); // positive control: no rows, no assertion
    const statuses = [...new Set((data ?? []).map((o: any) => o.status?.toLowerCase()))];
    const valid = ['pending', 'accepted', 'ready', 'completed', 'cancelled'];
    statuses.forEach((s) => expect(valid).toContain(s));
  });

  // DELETED: 'No pending orders without a tab_id'. It could never observe a row -- it used the
  // anon key, which staging RLS gives no access to `orders` at all, and it filtered on the
  // uppercase 'PENDING' while staging stores lowercase 'pending'. Fixing both does not save it:
  // the invariant is simply not true. Of staging's 17 fixture orders, one pending order has a
  // null tab_id, and a tab-less order is a legitimate shape (guest orders placed outside a tab),
  // not a defect. Asserting it would be red forever for a correct row.
});
