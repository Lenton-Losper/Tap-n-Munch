import { getSupabaseAdmin } from './helpers';
import { STAGING_TEST_RESTAURANT_ID, STAGING_TEST_USER_ID } from './helpers/staging-auth-fixtures';
import { VALID_ROLES, VALID_PAYMENT_METHODS, VALID_FEATURE_KEYS } from './constants';

/**
 * Every restaurant id in this file used to be a PRODUCTION venue (Riviera / ChowNow). This suite
 * runs against the STAGING Supabase project (.env.test -> mdqjpxwczrhkxkbqatqa), where those rows
 * do not exist, so every query matched zero rows. That did not just make tests red -- it made the
 * CHECK-constraint test below VACUOUS: PostgREST returns no error for an UPDATE that matches no
 * rows, so it passed identically whether the constraint was enforced or dropped.
 *
 * The ids now point at staging's own fixture venue. Do NOT re-point them at production.
 */
const UPTOWN_ID = '48457afc-46d3-49a5-8a8c-537122f89555'; // "Manual QA - Uptown", staging

describe('Schema constraints', () => {
  const sb = getSupabaseAdmin();

  test('payment_methods CHECK constraint rejects invalid values', async () => {
    // Positive control first. Without a row that actually matches, the UPDATE below returns no
    // error whether or not the constraint exists, and this test proves nothing.
    const { data: before, error: readError } = await sb
      .from('restaurant_settings')
      .select('payment_methods')
      .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
      .single();
    expect(readError).toBeNull();
    expect(before).not.toBeNull();

    const { error } = await sb
      .from('restaurant_settings')
      .update({ payment_methods: ['cashhhh'] })
      .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID);

    // If the constraint has been dropped the bad value landed on a shared staging row; put the
    // original back before failing, so one red run does not poison every other suite.
    if (!error) {
      await sb
        .from('restaurant_settings')
        .update({ payment_methods: before!.payment_methods })
        .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID);
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/payment_methods_valid_values/);
  });

  test('restaurant_users rejects an unknown role', async () => {
    // Was: RIVIERA_ID plus the all-zero user id. On staging that failed on
    // restaurant_users_user_id_fkey -- an error, so the assertion passed, but never once
    // exercised the role. A real staging user on a venue they are not yet a member of leaves the
    // role as the only thing that can be rejected. The role is enforced by an FK to
    // restaurant_roles rather than a CHECK, hence the constraint name asserted here.
    const { error } = await sb
      .from('restaurant_users')
      .insert({ restaurant_id: UPTOWN_ID, user_id: STAGING_TEST_USER_ID, role: 'superuser' });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/role/);
  });

  test('restaurant_features has all expected columns', async () => {
    const { data, error } = await sb
      .from('restaurant_features')
      .select(VALID_FEATURE_KEYS.join(', '))
      .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  // DELETED: 'ChowNow kiosk_enabled is true'. It asserted the VALUE of a feature flag on one
  // production venue (ChowNow), which is production configuration, not schema -- there is no
  // staging venue whose kiosk_enabled is meaningfully true, and flipping one to true just to
  // read it back would assert nothing the test above does not already cover (that select names
  // kiosk_enabled, so a dropped or renamed column still fails there).

  test('restaurant_settings payment_methods only contains valid values', async () => {
    const { data, error } = await sb
      .from('restaurant_settings')
      .select('restaurant_id, payment_methods')
      .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull(); // the row must exist, or the filter below is empty-set trivia
    const methods = data?.payment_methods ?? [];
    const invalid = methods.filter((m: string) => !VALID_PAYMENT_METHODS.includes(m));
    expect(invalid).toHaveLength(0);
  });

  test('restaurant_users roles are valid for all active staff', async () => {
    const { data, error } = await sb
      .from('restaurant_users')
      .select('role')
      .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
      .is('deleted_at', null);
    expect(error).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0); // zero staff would make the filter vacuous
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
