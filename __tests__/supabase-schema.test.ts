import { getSupabase, getSupabaseAdmin } from './helpers';
import { RIVIERA_ID, MINT_LEAF_ID } from './constants';

describe('Supabase — schema & data', () => {
  const sb = getSupabase();
  const admin = getSupabaseAdmin();

  test('Riviera row exists in restaurants', async () => {
    const { data, error } = await sb.from('restaurants').select('id,name').eq('id', RIVIERA_ID);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  test('Riviera has ~196 menu items', async () => {
    const { count, error } = await sb
      .from('menu_items')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', RIVIERA_ID);
    expect(error).toBeNull();
    expect(count).toBeGreaterThanOrEqual(180);
  });

  test('Riviera has ~29 menu categories', async () => {
    const { data, error } = await sb
      .from('menu_items')
      .select('category_id')
      .eq('restaurant_id', RIVIERA_ID);
    expect(error).toBeNull();
    const cats = new Set((data ?? []).map((i: any) => i.category_id).filter(Boolean));
    expect(cats.size).toBeGreaterThanOrEqual(25);
  });

  test('tabs.settled_type column exists', async () => {
    const { error } = await sb.from('tabs').select('settled_type').limit(1);
    expect(error).toBeNull();
  });

  test('orders.customer_ready_to_pay column exists', async () => {
    const { error } = await sb.from('orders').select('customer_ready_to_pay').limit(1);
    expect(error).toBeNull();
  });

  test('Riviera credentials are populated', async () => {
    // Finatic columns are revoked from anon (tenant-isolation RLS); use service role.
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
    const [{ data: r1 }, { data: r2 }] = await Promise.all([
      sb.from('menu_items').select('id').eq('restaurant_id', RIVIERA_ID),
      sb.from('menu_items').select('id').eq('restaurant_id', MINT_LEAF_ID),
    ]);
    const r1Ids = new Set((r1 ?? []).map((i: any) => i.id));
    const overlap = (r2 ?? []).filter((i: any) => r1Ids.has(i.id));
    expect(overlap).toHaveLength(0);
  });
});
