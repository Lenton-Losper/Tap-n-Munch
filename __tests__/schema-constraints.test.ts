import { getSupabaseAdmin } from './helpers';
import {
  RIVIERA_ID, CHOWNOW_ID,
  VALID_ROLES, VALID_PAYMENT_METHODS, VALID_FEATURE_KEYS
} from './constants';

describe('Schema constraints', () => {
  const sb = getSupabaseAdmin();

  test('payment_methods CHECK constraint rejects invalid values', async () => {
    // POSITIVE CONTROL FIRST. Without a row that actually matches, the UPDATE below returns no
    // error whether or not the constraint exists -- PostgREST reports success for a zero-row
    // update -- so this could not distinguish CHECK ENFORCED from CHECK DROPPED. It only ever
    // detected a missing row. That is true wherever this suite is pointed, which is why this half
    // of d5344c9 is kept while the rest of it is reverted.
    const { data: before, error: readError } = await sb
      .from('restaurant_settings')
      .select('payment_methods')
      .eq('restaurant_id', RIVIERA_ID)
      .single();
    expect(readError).toBeNull();
    expect(before).not.toBeNull();

    const { error } = await sb
      .from('restaurant_settings')
      .update({ payment_methods: ['cashhhh'] })
      .eq('restaurant_id', RIVIERA_ID);

    // If the constraint has been dropped the bad value LANDED on a real row. Put the original back
    // before failing, so one red run does not leave broken data behind for every later suite.
    if (!error) {
      await sb
        .from('restaurant_settings')
        .update({ payment_methods: before!.payment_methods })
        .eq('restaurant_id', RIVIERA_ID);
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/payment_methods_valid_values/);
  });

  test('restaurant_users role CHECK rejects invalid role', async () => {
    const { error } = await sb
      .from('restaurant_users')
      .insert({ restaurant_id: RIVIERA_ID, user_id: '00000000-0000-0000-0000-000000000000', role: 'superuser' });
    expect(error).not.toBeNull();
  });

  test('restaurant_features has all expected columns', async () => {
    const { data, error } = await sb
      .from('restaurant_features')
      .select(VALID_FEATURE_KEYS.join(', '))
      .eq('restaurant_id', CHOWNOW_ID)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  test('ChowNow kiosk_enabled is true', async () => {
    const { data, error } = await sb
      .from('restaurant_features')
      .select('kiosk_enabled')
      .eq('restaurant_id', CHOWNOW_ID)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data?.kiosk_enabled).toBe(true);
  });

  test('restaurant_settings payment_methods only contains valid values', async () => {
    const { data, error } = await sb
      .from('restaurant_settings')
      .select('restaurant_id, payment_methods')
      .eq('restaurant_id', RIVIERA_ID)
      .maybeSingle();
    expect(error).toBeNull();
    const methods = data?.payment_methods ?? [];
    const invalid = methods.filter((m: string) => !VALID_PAYMENT_METHODS.includes(m));
    expect(invalid).toHaveLength(0);
  });

  test('restaurant_users roles are valid for all active staff', async () => {
    const { data, error } = await sb
      .from('restaurant_users')
      .select('role')
      .eq('restaurant_id', RIVIERA_ID)
      .is('deleted_at', null);
    expect(error).toBeNull();
    const invalid = (data ?? []).filter((r: any) => !VALID_ROLES.includes(r.role));
    expect(invalid).toHaveLength(0);
  });

  test('subscriptions table exists and has correct columns', async () => {
    const { error } = await sb
      .from('subscriptions')
      .select('id, restaurant_id, plan, status, trial_ends_at, renews_at')
      .limit(1);
    expect(error).toBeNull();
  });

  test('platform_admins table exists', async () => {
    const { error } = await sb
      .from('platform_admins')
      .select('id, email, role')
      .limit(1);
    expect(error).toBeNull();
  });

  test('tabs table has customer_name column', async () => {
    const { error } = await sb
      .from('tabs')
      .select('customer_name')
      .limit(1);
    expect(error).toBeNull();
  });

  test('restaurant_tables has is_kiosk column', async () => {
    const { error } = await sb
      .from('restaurant_tables')
      .select('is_kiosk')
      .limit(1);
    expect(error).toBeNull();
  });
});
