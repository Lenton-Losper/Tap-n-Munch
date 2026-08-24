import { getSupabase, getSupabaseAdmin } from './helpers';
import { STAGING_TEST_RESTAURANT_ID } from './helpers/staging-auth-fixtures';

/**
 * This suite used to name the PRODUCTION Riviera and Mint Leaf venues while running against the
 * STAGING Supabase project (.env.test -> mdqjpxwczrhkxkbqatqa), where neither exists. Half the
 * tests were permanently red and the rest passed over an empty result set.
 *
 * It now uses staging's own fixture venue. The count assertions that encoded PRODUCTION SCALE
 * ("~196 menu items", "~29 categories") are gone: a fixture venue's row count is not a fact worth
 * protecting, and re-pointing them would only have swapped one hardcoded number for another that
 * breaks the next time somebody adds a test item. What replaced them is what those queries were
 * really standing guard over -- that anon can read the whole menu, and that the menu's categories
 * belong to the venue serving them. Do NOT re-point any of this at production.
 */
const UPTOWN_ID = '48457afc-46d3-49a5-8a8c-537122f89555'; // "Manual QA - Uptown", staging

describe('Supabase — schema & data', () => {
  const sb = getSupabase();
  const admin = getSupabaseAdmin();

  test('staging fixture restaurant row is readable by anon', async () => {
    const { data, error } = await sb.from('restaurants').select('id,name').eq('id', STAGING_TEST_RESTAURANT_ID);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  test('anon sees the fixture venue\'s entire menu', async () => {
    // Was `count >= 180`, a production-scale threshold. The regression this actually catches is
    // an RLS change that hides menu rows from the anon key -- which is every QR customer -- so it
    // is asserted directly: anon's count must equal the service role's, and must not be zero
    // (zero on both sides would make the comparison trivially true).
    const [anonRes, adminRes] = await Promise.all([
      sb.from('menu_items').select('id', { count: 'exact', head: true }).eq('restaurant_id', STAGING_TEST_RESTAURANT_ID),
      admin.from('menu_items').select('id', { count: 'exact', head: true }).eq('restaurant_id', STAGING_TEST_RESTAURANT_ID),
    ]);
    expect(anonRes.error).toBeNull();
    expect(adminRes.error).toBeNull();
    expect(adminRes.count).toBeGreaterThan(0);
    expect(anonRes.count).toBe(adminRes.count);
  });

  test('every menu item category belongs to the same restaurant', async () => {
    // Was `distinct category_id >= 25`, again production scale. The property worth holding is
    // tenant integrity: no item may point at another venue's category, and no category_id may
    // dangle. (Uncategorised items are normal here -- 12 of staging's 31 have a null
    // category_id -- so only the non-null ones are checked.)
    const { data: items, error } = await sb
      .from('menu_items')
      .select('category_id')
      .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID);
    expect(error).toBeNull();

    const catIds = [...new Set((items ?? []).map((i: any) => i.category_id).filter(Boolean))];
    expect(catIds.length).toBeGreaterThan(0); // positive control: an uncategorised menu proves nothing

    const { data: cats, error: catError } = await sb
      .from('menu_categories')
      .select('id, restaurant_id')
      .in('id', catIds);
    expect(catError).toBeNull();

    const dangling = catIds.filter((id) => !(cats ?? []).some((c: any) => c.id === id));
    expect(dangling).toEqual([]);
    const foreign = (cats ?? []).filter((c: any) => c.restaurant_id !== STAGING_TEST_RESTAURANT_ID);
    expect(foreign).toEqual([]);
  });

  test('tabs.settled_type column exists', async () => {
    const { error } = await sb.from('tabs').select('settled_type').limit(1);
    expect(error).toBeNull();
  });

  test('orders.customer_ready_to_pay column exists', async () => {
    const { error } = await sb.from('orders').select('customer_ready_to_pay').limit(1);
    expect(error).toBeNull();
  });

  test('fixture venue Finatic credentials are populated', async () => {
    // Finatic columns are revoked from anon (tenant-isolation RLS); use service role.
    const { data, error } = await admin
      .from('restaurants')
      .select('finatic_merchant_no, finatic_store_no')
      .eq('id', STAGING_TEST_RESTAURANT_ID)
      .single();
    expect(error).toBeNull();
    expect(data?.finatic_merchant_no).toBeTruthy();
    expect(data?.finatic_store_no).toBeTruthy();
  });

  test('No menu item cross-contamination between restaurants', async () => {
    // Was Riviera vs Mint Leaf, both production: on staging both sides came back empty and the
    // overlap was trivially zero. Staging's only two venues that own menu items are used instead.
    const [{ data: r1, error: e1 }, { data: r2, error: e2 }] = await Promise.all([
      sb.from('menu_items').select('id').eq('restaurant_id', STAGING_TEST_RESTAURANT_ID),
      sb.from('menu_items').select('id').eq('restaurant_id', UPTOWN_ID),
    ]);
    expect(e1).toBeNull();
    expect(e2).toBeNull();
    expect((r1 ?? []).length).toBeGreaterThan(0); // positive controls: two empty sets cannot overlap
    expect((r2 ?? []).length).toBeGreaterThan(0);

    const r1Ids = new Set((r1 ?? []).map((i: any) => i.id));
    const overlap = (r2 ?? []).filter((i: any) => r1Ids.has(i.id));
    expect(overlap).toHaveLength(0);
  });
});
