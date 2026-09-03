import { getSupabase, getSupabaseAdmin } from './helpers';
import { RIVIERA_ID, MINT_LEAF_ID } from './constants';
import { isProduction, resolvePrimaryVenue } from './target-project';

/**
 * TWO KINDS OF ASSERTION LIVED HERE UNDER ONE NAME, AND THAT IS WHY THEY WERE ALL RED.
 *
 * Every test named Riviera -- a PRODUCTION venue -- while this suite runs against STAGING, so the
 * reads returned nothing and four tests failed permanently. See __tests__/target-project.ts for
 * what that cost elsewhere: a payment-path CHECK constraint went unverified because its refusal
 * was buried in the same familiar list of red.
 *
 * Separated below:
 *
 *   STRUCTURAL -- a venue exists, it has a menu, its rows have the columns the app reads. True of
 *   any real venue, so asked of one that exists in whichever project this is pointed at.
 *
 *   PRODUCTION CONFIGURATION -- ~196 menu items, ~29 categories, Finatic credentials populated.
 *   These are monitoring of one specific live venue. Against staging they assert nothing and
 *   cannot pass; running them there did not make this suite stricter, it made it permanently red.
 *   They are gated to production, where they mean what they say.
 */
describe('Supabase — schema & data', () => {
  const sb = getSupabase();
  const admin = getSupabaseAdmin();

  test('the venue under test exists in restaurants', async () => {
    const venue = await resolvePrimaryVenue(admin);
    const { data, error } = await sb.from('restaurants').select('id,name').eq('id', venue.id);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  test('the venue under test has a menu', async () => {
    // A venue with zero menu items would make several assertions here vacuous rather than false,
    // which is the failure this whole pass is about. Asserted as a floor everywhere.
    const venue = await resolvePrimaryVenue(admin);
    const { count, error } = await sb
      .from('menu_items')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', venue.id);
    expect(error).toBeNull();
    expect(count ?? 0).toBeGreaterThan(0);
  });

  test('Riviera has ~196 menu items', async () => {
    if (!isProduction()) return;
    const { count, error } = await sb
      .from('menu_items')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', RIVIERA_ID);
    expect(error).toBeNull();
    expect(count).toBeGreaterThanOrEqual(180);
  });

  test('Riviera has ~29 menu categories', async () => {
    if (!isProduction()) return;
    const { data, error } = await sb
      .from('menu_items')
      .select('category_id')
      .eq('restaurant_id', RIVIERA_ID);
    expect(error).toBeNull();
    const cats = new Set((data ?? []).map((i: any) => i.category_id).filter(Boolean));
    expect(cats.size).toBeGreaterThanOrEqual(25);
  });

  test('tabs.settled_type column exists', async () => {
    // SERVICE ROLE, not anon. #284 withdrew the anon SELECT on `tabs` -- the policy had no
    // restaurant scope, so any holder of the browser key could enumerate every open tab at every
    // venue. This assertion is about the SCHEMA (does the column exist), which is not an
    // anon-permission question, and asking it through the anon key made a schema check fail for a
    // grant reason. Using `admin` restores what it was actually testing.
    const { error } = await admin.from('tabs').select('settled_type').limit(1);
    expect(error).toBeNull();
  });

  test('orders.customer_ready_to_pay column exists', async () => {
    const { error } = await sb.from('orders').select('customer_ready_to_pay').limit(1);
    expect(error).toBeNull();
  });

  test('the Finatic credential columns are readable through the service role', async () => {
    // The COLUMN-LEVEL GRANT is the half that is true everywhere, and it is the half that has
    // broken before: these columns are revoked from anon under tenant-isolation RLS, and a read
    // that comes back with an ERROR rather than a null is a grant regression, not missing data.
    const venue = await resolvePrimaryVenue(admin);
    const { data, error } = await admin
      .from('restaurants')
      .select('finatic_merchant_no, finatic_store_no')
      .eq('id', venue.id)
      .single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  test('Riviera credentials are populated', async () => {
    if (!isProduction()) return;
    const { data, error } = await admin
      .from('restaurants')
      .select('finatic_merchant_no, finatic_store_no')
      .eq('id', RIVIERA_ID)
      .single();
    expect(error).toBeNull();
    expect(data?.finatic_merchant_no).toBeTruthy();
    expect(data?.finatic_store_no).toBeTruthy();
  });

  test('No menu item cross-contamination between restaurants', async () => {
    // POSITIVE CONTROL. Both ids were production venues, so on staging both sides came back empty
    // and "no overlap" was true of two EMPTY SETS -- a green light that had never compared
    // anything, which is worse than the red ones above because nobody was ever going to look at
    // it. Two venues that actually have menus here are resolved instead, and the comparison is
    // asserted to be non-empty on both sides before its result is believed.
    const { data: venues, error: venuesError } = await sb.from('restaurants').select('id').limit(50);
    expect(venuesError).toBeNull();

    const withItems: string[] = [];
    for (const v of venues ?? []) {
      const { count } = await sb
        .from('menu_items')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', v.id);
      if ((count ?? 0) > 0) withItems.push(v.id);
      if (withItems.length === 2) break;
    }
    expect(withItems).toHaveLength(2);

    const [{ data: r1 }, { data: r2 }] = await Promise.all([
      sb.from('menu_items').select('id').eq('restaurant_id', withItems[0]),
      sb.from('menu_items').select('id').eq('restaurant_id', withItems[1]),
    ]);
    expect((r1 ?? []).length).toBeGreaterThan(0);
    expect((r2 ?? []).length).toBeGreaterThan(0);

    const r1Ids = new Set((r1 ?? []).map((i: any) => i.id));
    const overlap = (r2 ?? []).filter((i: any) => r1Ids.has(i.id));
    expect(overlap).toHaveLength(0);
  });

  test('Riviera and Mint Leaf menus do not overlap', async () => {
    if (!isProduction()) return;
    const [{ data: r1 }, { data: r2 }] = await Promise.all([
      sb.from('menu_items').select('id').eq('restaurant_id', RIVIERA_ID),
      sb.from('menu_items').select('id').eq('restaurant_id', MINT_LEAF_ID),
    ]);
    const r1Ids = new Set((r1 ?? []).map((i: any) => i.id));
    const overlap = (r2 ?? []).filter((i: any) => r1Ids.has(i.id));
    expect(overlap).toHaveLength(0);
  });
});
