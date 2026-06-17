import { getSupabase } from './helpers';
import { RIVIERA_ID, P5_TERMINAL_SN } from './constants';

describe('APK & terminal logic', () => {
  const sb = getSupabase();

  test('Riviera has finatic_terminal_sn set', async () => {
    const { data, error } = await sb
      .from('restaurants')
      .select('finatic_terminal_sn')
      .eq('id', RIVIERA_ID)
      .single();
    expect(error).toBeNull();
    expect(data?.finatic_terminal_sn).toBeTruthy();
  });

  test('Riviera terminal SN matches P5 or dev phone', async () => {
    const { data } = await sb
      .from('restaurants')
      .select('finatic_terminal_sn')
      .eq('id', RIVIERA_ID)
      .single();
    const validSNs = [P5_TERMINAL_SN, '0ccdbf19965fecb6'];
    expect(validSNs).toContain(data?.finatic_terminal_sn);
  });

  test('Orders have a timestamp column', async () => {
    const { error } = await sb.from('orders').select('placed_at').limit(1);
    expect(error).toBeNull();
    // placed_at is the available timestamp; created_at/updated_at do not exist in prod schema
  });

  test('All Riviera order statuses are valid', async () => {
    const { data, error } = await sb
      .from('orders')
      .select('status')
      .eq('restaurant_id', RIVIERA_ID)
      .limit(200);
    expect(error).toBeNull();
    const statuses = [...new Set((data ?? []).map((o: any) => o.status?.toLowerCase()))];
    const valid = ['pending', 'accepted', 'ready', 'completed', 'cancelled'];
    statuses.forEach((s) => expect(valid).toContain(s));
  });

  test('No pending orders without a tab_id', async () => {
    const { data, error } = await sb
      .from('orders')
      .select('id, tab_id')
      .eq('status', 'PENDING')
      .limit(100);
    expect(error).toBeNull();
    const orphans = (data ?? []).filter((o: any) => !o.tab_id);
    expect(orphans).toHaveLength(0);
  });
});
