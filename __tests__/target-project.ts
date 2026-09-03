/**
 * __tests__/target-project.ts — WHICH DATABASE IS THIS SUITE ACTUALLY POINTED AT, AND WHICH VENUE
 * IN IT IS REAL.
 *
 * ============================================================================================
 * THE BUG THIS EXISTS TO END
 * ============================================================================================
 *
 * Five suites hard-coded `RIVIERA_ID` — `01bf27f1-a958-4322-bb3e-cc5240987808` — and then ran
 * against `.env.test`, which points at STAGING. Riviera is a PRODUCTION venue. The row has never
 * existed in the database these tests query, so every one of them failed on a setup read, and had
 * been failing long enough that nineteen red tests were treated as the baseline.
 *
 * That is not a cosmetic problem, and one case proves it. `schema-constraints.test.ts` asks
 * whether the payment_methods CHECK constraint rejects a bad value. Its own docblock explains that
 * a zero-row UPDATE returns no error whether the constraint exists or not, so it added a positive
 * control — read the row first — precisely so a missing row could not be mistaken for an enforced
 * constraint. That control did its job: it refused. But because the refusal looked like just
 * another entry in a familiar list of red, nobody read it, and THE CONSTRAINT ON THE PAYMENT PATH
 * WENT UNVERIFIED FOR AS LONG AS THE BASELINE WAS BROKEN. A broken baseline is how a real failure
 * hides, and this is what that looks like in practice.
 *
 * ============================================================================================
 * TWO DIFFERENT KINDS OF ASSERTION, WHICH IS WHY THIS FILE HAS TWO EXPORTS
 * ============================================================================================
 *
 * Some of what those suites assert is STRUCTURAL and true of any real venue: a settings row
 * exists, a CHECK constraint rejects rubbish, a venue has menu items. Those should run wherever
 * the suite is pointed, against a venue that exists THERE. `resolvePrimaryVenue` finds it.
 *
 * The rest are facts about PRODUCTION CONFIGURATION: Riviera's Finatic terminal serial is the P5,
 * ChowNow has the kiosk enabled, Riviera has ~196 menu items. Those are monitoring, not tests, and
 * they are meaningless against staging — asserting them there does not make the suite stricter, it
 * makes it permanently red, which is strictly worse than not asserting them at all. `isProduction`
 * gates them.
 *
 * ============================================================================================
 * NEITHER HELPER MAY EVER SILENTLY SKIP
 * ============================================================================================
 *
 * A test that quietly does nothing is the failure mode this whole change is about. So:
 *
 *   - `targetProject()` THROWS on a database it does not recognise, rather than guessing. An
 *     unknown project must not be allowed to satisfy a production gate by default, nor to
 *     disable one.
 *   - `resolvePrimaryVenue()` THROWS when no venue qualifies, naming what it looked for. "No
 *     venue found" must fail the suite, never resolve to `undefined` and let a later `.eq()`
 *     match zero rows — which is exactly how the original bug read as a pass in the UPDATE.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const PRODUCTION_REF = 'ihlmmpmolnpchzgwyhgh'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'

export type TargetProject = 'production' | 'staging'

/** Read off the URL the suite is actually configured with, never from a NODE_ENV-style guess. */
export function targetProject(): TargetProject {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  if (url.includes(PRODUCTION_REF)) return 'production'
  if (url.includes(STAGING_REF)) return 'staging'
  throw new Error(
    `Cannot tell which Supabase project these tests are pointed at (SUPABASE_URL=${url || '<unset>'}). ` +
      'Refusing to guess: an unrecognised project must not silently satisfy — or silently disable — ' +
      'a production-only assertion.',
  )
}

export const isProduction = () => targetProject() === 'production'

export type PrimaryVenue = { id: string; name: string }

/**
 * The venue in THIS project that the structural assertions should be made against: the one that
 * actually has a settings row, because that is what those assertions need in order to mean
 * anything. On production that is Riviera; on staging it is the `staging test` venue.
 *
 * Cached for the life of the module — it is one round trip and the answer cannot change mid-run.
 */
let cached: PrimaryVenue | null = null

export async function resolvePrimaryVenue(sb: SupabaseClient): Promise<PrimaryVenue> {
  if (cached) return cached

  const { data: settings, error: settingsError } = await sb
    .from('restaurant_settings')
    .select('restaurant_id')
    .limit(50)
  if (settingsError) {
    throw new Error(`Could not read restaurant_settings to resolve a venue: ${settingsError.message}`)
  }
  const ids = (settings ?? []).map((r: { restaurant_id: string }) => r.restaurant_id)
  if (ids.length === 0) {
    throw new Error(
      `No restaurant_settings row exists in the ${targetProject()} project, so there is no venue ` +
        'against which a settings-shaped assertion could mean anything. Refusing rather than ' +
        'matching zero rows: a zero-row UPDATE reports success whether a CHECK constraint is ' +
        'enforced or dropped.',
    )
  }

  // Prefer the venue with the most menu items -- on either project that is the one set up to look
  // like a real restaurant, rather than a leftover fixture from a signup test.
  //
  // COUNTED SERVER-SIDE, one HEAD request per candidate. The first version selected every
  // menu_items row for every candidate and assembled the tally in JS: harmless against staging's
  // 44 rows, but on production that is thousands of rows pulled over the wire to compute a number
  // Postgres will return on its own, and it was already slow enough to make this suite flaky in a
  // batch run.
  const counts = await Promise.all(
    ids.map(async (id) => {
      const { count } = await sb
        .from('menu_items')
        .select('id', { count: 'exact', head: true })
        .eq('restaurant_id', id)
      return { id, count: count ?? 0 }
    }),
  )
  // Sorted by id as the tie-break so the choice is DETERMINISTIC. Two fixture venues with equal
  // counts must not resolve differently between runs, or a failure becomes unreproducible.
  counts.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
  const bestId = counts[0].id

  const { data: venue, error: venueError } = await sb
    .from('restaurants')
    .select('id, name')
    .eq('id', bestId)
    .single()
  if (venueError || !venue) {
    throw new Error(`Resolved venue ${bestId} has no restaurants row: ${venueError?.message ?? 'not found'}`)
  }

  cached = { id: venue.id, name: venue.name }
  return cached
}

/** Test seam — the module-level cache would otherwise leak between suites in the same worker. */
export function resetPrimaryVenueForTest(): void {
  cached = null
}
