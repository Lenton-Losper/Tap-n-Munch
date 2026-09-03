import { getSupabaseAdmin } from './helpers';
import { CHOWNOW_ID, VALID_ROLES, VALID_PAYMENT_METHODS, VALID_FEATURE_KEYS } from './constants';
import { isProduction, resolvePrimaryVenue } from './target-project';

/**
 * WHY THIS SUITE NO LONGER NAMES RIVIERA.
 *
 * Every assertion below used RIVIERA_ID, a PRODUCTION venue, while `.env.test` points at STAGING.
 * The row has never existed in the database this suite queries, so the setup reads failed and the
 * assertions after them never ran at all.
 *
 * That mattered most in the first test. It checks that the payment_methods CHECK constraint
 * rejects a bad value, and its own docblock (kept below) explains that a zero-row UPDATE reports
 * success whether the constraint is enforced or dropped -- which is why it reads a row first. That
 * positive control worked exactly as designed: it refused. But its refusal sat in a list of
 * nineteen familiar red tests, so nobody read it, and the CHECK constraint on the payment path was
 * unverified for as long as the broken baseline persisted. That is a broken baseline hiding a real
 * question, which is the whole reason for this pass.
 *
 * `resolvePrimaryVenue` finds a venue that exists in whichever project the suite is pointed at, so
 * a structural assertion is made against something real either way. It THROWS when no venue
 * qualifies -- never resolves to undefined, because an `.eq()` against undefined is how a zero-row
 * match sneaks back in.
 */
describe('Schema constraints', () => {
  const sb = getSupabaseAdmin();

  test('payment_methods CHECK constraint rejects invalid values', async () => {
    const venue = await resolvePrimaryVenue(sb);

    // POSITIVE CONTROL FIRST. Without a row that actually matches, the UPDATE below returns no
    // error whether or not the constraint exists -- PostgREST reports success for a zero-row
    // update -- so this could not distinguish CHECK ENFORCED from CHECK DROPPED. It only ever
    // detected a missing row. That is true wherever this suite is pointed, which is why this half
    // of d5344c9 is kept while the rest of it is reverted.
    const { data: before, error: readError } = await sb
      .from('restaurant_settings')
      .select('payment_methods')
      .eq('restaurant_id', venue.id)
      .single();
    expect(readError).toBeNull();
    expect(before).not.toBeNull();

    const { error } = await sb
      .from('restaurant_settings')
      .update({ payment_methods: ['cashhhh'] })
      .eq('restaurant_id', venue.id);

    // If the constraint has been dropped the bad value LANDED on a real row. Put the original back
    // before failing, so one red run does not leave broken data behind for every later suite.
    if (!error) {
      await sb
        .from('restaurant_settings')
        .update({ payment_methods: before!.payment_methods })
        .eq('restaurant_id', venue.id);
    }

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/payment_methods_valid_values/);
  });

  test('an invalid staff role is rejected, and a valid one is not', async () => {
    /**
     * THIS TEST NEVER TESTED WHAT IT WAS NAMED AFTER, AND IT PASSED THE WHOLE TIME.
     *
     * It used to INSERT a row with role 'superuser' and assert an error came back. An error always
     * came back -- but never the one it was looking for:
     *
     *   RIVIERA_ID (a production venue, absent from staging)
     *     -> FK violation on restaurant_users_restaurant_id_fkey
     *   a venue that DOES exist here, with user_id all-zeroes
     *     -> FK violation on restaurant_users_user_id_fkey
     *   that same venue AND A PERFECTLY VALID ROLE
     *     -> the SAME FK violation
     *
     * It passed for a valid role. It could not distinguish "this role is rejected" from "this row
     * is rejected", so it asserted nothing about roles at all -- the same shape as the
     * payment_methods test above, except presenting as a permanent GREEN rather than a red, which
     * is strictly worse: nobody investigates a passing test.
     *
     * It now UPDATES a row that already exists, which is the only arrangement where the role is the
     * variable under test, and it carries its own POSITIVE CONTROL: a valid role must be ACCEPTED
     * on the same row in the same shape. Without that half, an update refused for any unrelated
     * reason would read as the constraint working.
     *
     * Enforcement is a FOREIGN KEY to the roles table (restaurant_users_role_slug_fkey), not a
     * CHECK -- established by probing it, which is why the old name was wrong about the mechanism.
     */
    const { data: rows, error: readError } = await sb
      .from('restaurant_users')
      .select('id, role')
      .limit(1);
    expect(readError).toBeNull();
    if (!rows || rows.length === 0) {
      throw new Error(
        'No restaurant_users row exists in this project, so nothing can distinguish a rejected ' +
          'role from a rejected row. Refusing rather than asserting on an empty set.',
      );
    }
    const row = rows[0];

    // POSITIVE CONTROL: the same update shape with a role that IS valid must succeed.
    const { error: validError } = await sb
      .from('restaurant_users')
      .update({ role: row.role })
      .eq('id', row.id);
    expect(validError).toBeNull();

    // The actual assertion.
    const { error: invalidError } = await sb
      .from('restaurant_users')
      .update({ role: 'superuser' })
      .eq('id', row.id);
    expect(invalidError).not.toBeNull();
    expect(invalidError?.message).toMatch(/role/i);

    // And the refused write changed nothing.
    const { data: after } = await sb
      .from('restaurant_users')
      .select('role')
      .eq('id', row.id)
      .single();
    expect(after?.role).toBe(row.role);
  });

  test('restaurant_features has all expected columns', async () => {
    // The COLUMNS are the assertion, and every venue with a features row exercises them equally.
    // Naming ChowNow made this a production-data check wearing a schema check's name.
    const venue = await resolvePrimaryVenue(sb);
    const { data, error } = await sb
      .from('restaurant_features')
      .select(VALID_FEATURE_KEYS.join(', '))
      .eq('restaurant_id', venue.id)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  test('ChowNow kiosk_enabled is true', async () => {
    // PRODUCTION CONFIGURATION, not schema: ChowNow is a production venue and this is monitoring
    // of its setup. Asserted only where it can be true. Skipping it on staging is not a loss --
    // asserting it there never tested anything, it just kept the suite permanently red, which is
    // how the payment-path refusal three tests up went unread.
    if (!isProduction()) return;
    const { data, error } = await sb
      .from('restaurant_features')
      .select('kiosk_enabled')
      .eq('restaurant_id', CHOWNOW_ID)
      .maybeSingle();
    expect(error).toBeNull();
    expect(data?.kiosk_enabled).toBe(true);
  });

  test('restaurant_settings payment_methods only contains valid values', async () => {
    const venue = await resolvePrimaryVenue(sb);
    const { data, error } = await sb
      .from('restaurant_settings')
      .select('restaurant_id, payment_methods')
      .eq('restaurant_id', venue.id)
      .maybeSingle();
    expect(error).toBeNull();
    const methods = data?.payment_methods ?? [];
    const invalid = methods.filter((m: string) => !VALID_PAYMENT_METHODS.includes(m));
    expect(invalid).toHaveLength(0);
  });

  test('restaurant_users roles are valid for all active staff', async () => {
    const venue = await resolvePrimaryVenue(sb);
    const { data, error } = await sb
      .from('restaurant_users')
      .select('role')
      .eq('restaurant_id', venue.id)
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
