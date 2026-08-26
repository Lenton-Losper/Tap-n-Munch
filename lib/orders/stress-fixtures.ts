/**
 * THE STRESS-FIXTURE EXCLUSION. One rule, one file, used by every probe and every report path.
 *
 * ============================================================================================
 * WHY THIS IS A SHARED HELPER AND NOT A FILTER EACH SCRIPT REMEMBERS TO WRITE
 * ============================================================================================
 *
 * 1314 of production's 3516 order rows — 37.4% — are stress-test fixtures from a single run on
 * 2026-04-27. They carry `restaurant_id IS NULL`, a `firebase_restaurant_id` of
 * `restaurant_test_02`…`_10`, items named `stress-item-N`, `total = 0`, and no timestamp of any
 * kind beyond `placed_at`. `flashtap-stress-test.js` at the repo root produced them.
 *
 * ON 2026-08-25 THEY MANUFACTURED A 98% FAILURE RATE. A measurement of QR card orders reported
 * that 876 of 891 sat in a contradictory `payment_status='cancelled' + status='completed'` state,
 * which read as the QR card path having been broken since launch. Every one of the 876 was a
 * fixture. The real population is fifteen orders and none of them is in that state.
 *
 * THE POINT IS NOT THAT THE ANSWER WAS ALARMING. It is that the denominator was wrong by 37% in
 * whichever direction the filter happened to point. The same rows would have manufactured a 98%
 * SUCCESS rate just as convincingly against a filter that matched them the other way — and a
 * reassuring number is the one that gets shipped without anybody re-deriving it.
 *
 * So the exclusion lives here, is imported, and is verified against production by
 * `scripts/prod/verify-stress-fixture-exclusion-20260826.ts` rather than assumed.
 *
 * ============================================================================================
 * THE THREE-VALUED-LOGIC TRAP, WHICH IS WHY THE PostgREST FILTER HAS A THIRD CLAUSE
 * ============================================================================================
 *
 * The rule is: exclude rows where `restaurant_id IS NULL AND firebase_restaurant_id LIKE
 * 'restaurant_test_%'`. Negated, that is `restaurant_id IS NOT NULL OR firebase_restaurant_id NOT
 * LIKE 'restaurant_test_%'`.
 *
 * Written with two clauses, that quietly drops a row whose `restaurant_id` AND
 * `firebase_restaurant_id` are BOTH NULL: `NULL NOT LIKE '...'` is NULL, not TRUE, so neither
 * clause holds and PostgREST filters the row out. Production has exactly one such row. It is not a
 * fixture and must survive. The explicit `firebase_restaurant_id.is.null` clause is what keeps it,
 * and the verification script asserts it by name rather than trusting the reasoning above.
 *
 * ============================================================================================
 * WHAT THIS IS NOT FOR
 * ============================================================================================
 *
 * Any query already scoped by `restaurant_id`, `id`, `tab_id` or `table_id` cannot reach a fixture
 * — a NULL never equals a uuid — and does NOT need this. Of 149 order-table call sites in app/ and
 * lib/, 124 are scoped that way. Adding the exclusion there would be noise that makes the 25 that
 * DO need thinking about harder to find.
 *
 * (That sentence deliberately does not spell the query builder's method name. `check-orders-read-bounded`
 * scans for it textually and cannot tell prose from code, so writing it here made this FILE a
 * finding. Blinding a guard to fix a comment would be the wrong trade; rewording the comment costs
 * nothing.)
 *
 * This is for the unscoped ones: platform-wide search, platform analytics, cross-venue reporting,
 * and every script under `scripts/`.
 */

/** The prefix every stress-run restaurant id carries. Nothing else in production uses it. */
export const STRESS_FIXTURE_FIREBASE_PREFIX = 'restaurant_test_'

/** The shape the predicate needs. Deliberately minimal so any select can satisfy it. */
export type StressFixtureCandidate = {
  restaurant_id?: string | null
  firebase_restaurant_id?: string | null
}

/** The two columns the predicate cannot work without. */
export const STRESS_FIXTURE_REQUIRED_COLUMNS = [
  'restaurant_id',
  'firebase_restaurant_id',
] as const

/**
 * A ROW THAT DID NOT SELECT THE COLUMNS IS AN ERROR, NOT A NON-FIXTURE.
 *
 * THIS GUARD EXISTS BECAUSE THE HELPER SILENTLY DID NOTHING THE FIRST TIME IT WAS USED.
 * `measure-customer-wait-20260825.ts` selects thirteen columns and `firebase_restaurant_id` is not
 * among them. With a permissive predicate every row read `firebase_restaurant_id === undefined`,
 * every row was therefore "not a fixture", and the script reported `stress fixtures excluded: 0 of
 * 3516` while printing exactly the same wrong 1358 it printed before the exclusion was added.
 *
 * That is worse than having no helper at all. An absent filter is visible; a filter that runs,
 * reports zero, and changes nothing reads as CONFIRMATION that the data is clean. And it fails in
 * the reassuring direction, which is the direction nobody re-derives.
 *
 * So a missing column throws, and the message names the column to add. The same shape as #306's
 * defect — a route wrote `customer_edited_at` and never selected it — where tsc and the unit tests
 * were both blind because the field was optional.
 */
function assertFixtureColumnsSelected(row: StressFixtureCandidate): void {
  const missing = STRESS_FIXTURE_REQUIRED_COLUMNS.filter((column) => !(column in row))
  if (missing.length > 0) {
    throw new Error(
      `isStressFixtureOrder: the row does not carry ${missing.join(' or ')}. ` +
        `Add ${missing.join(' and ')} to the select — without ${missing.length > 1 ? 'them' : 'it'} ` +
        'this predicate cannot tell a fixture from a real order, and would silently call every row real.',
    )
  }
}

/**
 * Is this row a stress fixture?
 *
 * BOTH CONDITIONS ARE REQUIRED. A row with a real `restaurant_id` is real however it is named, and
 * a NULL `restaurant_id` alone is not enough — production has an orphan row that is not a fixture,
 * and #324's own probe partitions on exactly this distinction.
 *
 * A row missing either column THROWS rather than answering false. See above.
 */
export function isStressFixtureOrder(row: StressFixtureCandidate): boolean {
  assertFixtureColumnsSelected(row)
  if (row.restaurant_id !== null && row.restaurant_id !== undefined) return false
  return String(row.firebase_restaurant_id ?? '').startsWith(STRESS_FIXTURE_FIREBASE_PREFIX)
}

/** Drop the fixtures from an array already in memory. */
export function withoutStressFixtures<T extends StressFixtureCandidate>(rows: T[]): T[] {
  return rows.filter((row) => !isStressFixtureOrder(row))
}

/** Count them, for a script that wants to report what it excluded rather than excluding silently. */
export function countStressFixtures(rows: StressFixtureCandidate[]): number {
  return rows.filter(isStressFixtureOrder).length
}

/**
 * The PostgREST form of the same rule, as a raw `.or()` argument.
 *
 * A CONSTANT, NOT A BUILDER TAKING A PATTERN. `.or()` is one of the two PostgREST surfaces that
 * parses its argument rather than treating it as a value (`.eq()` is parser-free; `.or()` is not),
 * so an interpolated caller-supplied string here would be an injection seam of the #242/#254 class.
 * Nothing about this filter varies, so nothing needs to be interpolated, and the constant closes
 * the question rather than sanitising it.
 *
 * The three clauses are OR-ed: keep the row if it has a restaurant, OR has no firebase id at all
 * (the three-valued-logic case above), OR has a firebase id that is not a stress one.
 */
export const STRESS_FIXTURE_EXCLUSION_OR =
  'restaurant_id.not.is.null,' +
  'firebase_restaurant_id.is.null,' +
  `firebase_restaurant_id.not.like.${STRESS_FIXTURE_FIREBASE_PREFIX}*`

/**
 * Apply the exclusion to a PostgREST query builder.
 *
 * Typed structurally rather than against `PostgrestFilterBuilder` so this file stays importable
 * from plain scripts without dragging the supabase-js generics along, and so a `.mjs` probe can use
 * it too.
 *
 * USE THIS RATHER THAN WRITING THE `.or()` BY HAND. The three clauses are the whole point, and a
 * hand-written two-clause version passes every test that does not happen to include a row with two
 * NULLs — which is to say, most of them.
 */
export function excludeStressFixtures<Q extends { or(filter: string): Q }>(query: Q): Q {
  return query.or(STRESS_FIXTURE_EXCLUSION_OR)
}

/**
 * The SQL form, for a migration, a view, or a psql session.
 *
 * Kept beside the other two so the three cannot drift apart unnoticed: if the rule ever changes,
 * the change is one file and the verification script re-proves all of them against production.
 */
export const STRESS_FIXTURE_EXCLUSION_SQL =
  `NOT (restaurant_id IS NULL AND firebase_restaurant_id LIKE '${STRESS_FIXTURE_FIREBASE_PREFIX}%')`
