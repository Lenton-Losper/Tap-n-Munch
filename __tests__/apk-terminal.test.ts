import { getSupabase, getSupabaseAdmin } from './helpers';
import { RIVIERA_ID, P5_TERMINAL_SN, DEV_PHONE_SN } from './constants';
import { isProduction, resolvePrimaryVenue } from './target-project';

/**
 * The two Finatic-serial tests here are MONITORING OF ONE PHYSICAL DEVICE at one live venue, not
 * logic: "Riviera's terminal serial is the P5, or the dev phone". That is a real thing to check,
 * and it is meaningless against staging, where `finatic_terminal_sn` is null because no card
 * machine has ever been paired there. Pointed at staging they could only ever fail, and their
 * failure was part of the nineteen-red baseline that hid a payment-path constraint going
 * unverified -- see __tests__/target-project.ts.
 *
 * They are gated to production. What replaces them everywhere else is the assertion that holds
 * everywhere: the column is readable through the service role, which is the part that regresses
 * when a grant changes.
 */
describe('APK & terminal logic', () => {
  const sb = getSupabase();
  const admin = getSupabaseAdmin();

  test('finatic_terminal_sn is readable through the service role', async () => {
    const venue = await resolvePrimaryVenue(admin);
    const { data, error } = await admin
      .from('restaurants')
      .select('finatic_terminal_sn')
      .eq('id', venue.id)
      .single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });

  test('Riviera has finatic_terminal_sn set', async () => {
    if (!isProduction()) return;
    const { data, error } = await admin
      .from('restaurants')
      .select('finatic_terminal_sn')
      .eq('id', RIVIERA_ID)
      .single();
    expect(error).toBeNull();
    expect(data?.finatic_terminal_sn).toBeTruthy();
  });

  test('Riviera terminal SN matches P5 or dev phone', async () => {
    if (!isProduction()) return;
    const { data } = await admin
      .from('restaurants')
      .select('finatic_terminal_sn')
      .eq('id', RIVIERA_ID)
      .single();
    const validSNs = [P5_TERMINAL_SN, DEV_PHONE_SN];
    expect(validSNs).toContain(data?.finatic_terminal_sn);
  });

  test('Orders have a timestamp column', async () => {
    const { error } = await sb.from('orders').select('placed_at').limit(1);
    expect(error).toBeNull();
    // placed_at is the available timestamp; created_at/updated_at do not exist in prod schema
  });

  test('All order statuses at the venue under test are valid', async () => {
    // Was scoped to RIVIERA_ID, so on staging it read zero orders and passed over an empty list --
    // green without having checked a single status. Scoped to a venue that exists here instead.
    const venue = await resolvePrimaryVenue(admin);
    const { data, error } = await sb
      .from('orders')
      .select('status')
      .eq('restaurant_id', venue.id)
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
