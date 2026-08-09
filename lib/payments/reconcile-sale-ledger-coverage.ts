import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { isPaidPaymentStatus } from '@/lib/payments/payment-integrity'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/** audit_logs.action for a venue whose SALE coverage has degraded. Alerted on the ops console. */
export const SALE_LEDGER_COVERAGE_DEGRADED_ACTION = 'payment.sale_ledger_coverage_degraded'

/**
 * audit_logs.action written on EVERY run, degraded or not.
 *
 * The heartbeat is not decoration. The auto-cancel cron failed silently for three days (#153)
 * because a job that stops running looks exactly like a job with nothing to report. A row per
 * run means the absence of rows is itself the signal.
 */
export const SALE_LEDGER_RECONCILIATION_HEARTBEAT_ACTION = 'payment.sale_ledger_reconciliation'

/**
 * Missing-SALE ratio at which a venue is considered degraded.
 *
 * Calibrated against the actual outage in the Discovery Note rather than picked round. Healthy
 * days at volume run at or below 2.4% (FNB ChowNow: 0/100 on 22 July, 2/176 on 23 July,
 * 4/170 on 24 July). The outage reads 40% on 27 July, 94% on 28 July, 100% on 29 July. 15%
 * sits roughly 6x above the healthy ceiling and well below the first bad day, so it fires on
 * 27 July -- the day the brief requires it to fire -- without firing on any healthy day in the
 * measured history.
 */
export const COVERAGE_MISSING_RATIO_THRESHOLD = 0.15

/**
 * Below this many paid card orders in the window, ratios are noise: one miss out of one order
 * is 100% and means nothing. Suppresses the ratio rule only -- see the degradation rule below.
 */
export const COVERAGE_MIN_SAMPLE = 5

/** A venue that was healthy and multiplied its miss rate by this much is degrading. */
export const COVERAGE_DEGRADATION_MULTIPLIER = 3

/** Floor for the degradation rule, so 0.1% -> 0.3% is not treated as an incident. */
export const COVERAGE_DEGRADATION_FLOOR = 0.05

export type VenueCoverage = {
  restaurantId: string
  restaurantName: string | null
  paidCount: number
  missingCount: number
  missingRatio: number
  previousPaidCount: number
  previousMissingCount: number
  previousMissingRatio: number | null
  missingOrderIds: string[]
  degraded: boolean
  trigger: string | null
}

export type CoverageReport = {
  windowHours: number
  windowStart: string
  windowEnd: string
  venues: VenueCoverage[]
  totals: { paidCount: number; missingCount: number; degradedVenues: number }
}

/**
 * Whether a venue's coverage is bad enough to alert, and why.
 *
 * Pure, and exported so it can be driven directly with the real per-day figures from the
 * Discovery Note. Two rules, because one is not enough:
 *
 *  - RATIO: the miss rate is high in absolute terms. Catches a venue that is already broken,
 *    including one that was broken before this check existed.
 *  - DEGRADATION: the miss rate multiplied against a previously healthy window. Catches the
 *    slope early -- this is what "alert on a sharp ratio degradation rather than an absolute
 *    count" asks for, and it fires before the ratio rule does on a venue heading for total
 *    failure.
 *
 * Not an absolute count, deliberately. A count threshold fires on a busy healthy venue and
 * stays quiet on a small venue that has lost every payment: Riviera's total failure is 7
 * orders, FNB ChowNow's healthy day is 176.
 */
export function assessVenueCoverage(input: {
  paidCount: number
  missingCount: number
  previousMissingRatio: number | null
}): { degraded: boolean; trigger: string | null } {
  const { paidCount, missingCount, previousMissingRatio } = input
  if (paidCount <= 0 || missingCount <= 0) return { degraded: false, trigger: null }

  const ratio = missingCount / paidCount

  if (paidCount >= COVERAGE_MIN_SAMPLE && ratio >= COVERAGE_MISSING_RATIO_THRESHOLD) {
    return {
      degraded: true,
      trigger: `missing ratio ${(ratio * 100).toFixed(0)}% at or above the ${(
        COVERAGE_MISSING_RATIO_THRESHOLD * 100
      ).toFixed(0)}% threshold`,
    }
  }

  if (
    paidCount >= COVERAGE_MIN_SAMPLE &&
    previousMissingRatio !== null &&
    ratio >= COVERAGE_DEGRADATION_FLOOR &&
    ratio >= previousMissingRatio * COVERAGE_DEGRADATION_MULTIPLIER &&
    ratio > previousMissingRatio
  ) {
    return {
      degraded: true,
      trigger: `missing ratio rose from ${(previousMissingRatio * 100).toFixed(1)}% to ${(
        ratio * 100
      ).toFixed(1)}% in one window`,
    }
  }

  return { degraded: false, trigger: null }
}

type PaidOrderRow = {
  id: string
  restaurant_id: string
  payment_status: unknown
  payment_method: unknown
  paid_at: string | null
}

/** PostgREST puts the filter in the URL, so the id list has to be chunked. */
const ORDER_ID_CHUNK = 100

async function orderIdsWithSaleRows(
  supabase: Supabase,
  orderIds: string[],
): Promise<{ covered: Set<string>; error: string | null }> {
  const covered = new Set<string>()
  for (let i = 0; i < orderIds.length; i += ORDER_ID_CHUNK) {
    const chunk = orderIds.slice(i, i + ORDER_ID_CHUNK)
    // overlaps() on the uuid[] is the same array-containment linkage the Discovery Note
    // measured (490 rows, 1:1, zero orphans). Matching on order_ids rather than on
    // business_order_no is load-bearing: references rotate (PR #113) and the array does not.
    const { data, error } = await supabase
      .from('payment_events')
      .select('order_ids')
      .eq('event_type', 'sale')
      .overlaps('order_ids', chunk)

    // A failed read must never be reported as "no SALE rows found" -- that would invent an
    // outage out of a transport error and is how a monitoring check earns its way to muted.
    if (error) return { covered, error: error.message }

    for (const row of data ?? []) {
      const ids = Array.isArray(row.order_ids) ? row.order_ids : []
      for (const id of ids) covered.add(String(id))
    }
  }
  return { covered, error: null }
}

async function collectWindow(
  supabase: Supabase,
  startIso: string,
  endIso: string,
  restaurantId?: string,
): Promise<{ byVenue: Map<string, { paid: string[]; missing: string[] }>; error: string | null }> {
  const byVenue = new Map<string, { paid: string[]; missing: string[] }>()

  // payment_status is NOT filtered byte-exact in SQL. A stray 'Paid' would be missed by
  // .eq('payment_status','paid'), and this check exists to find records that are missing --
  // so it must not have a blind spot of its own. Read, then partition with the helper.
  let query = supabase
    .from('orders')
    .select('id, restaurant_id, payment_status, payment_method, paid_at')
    .gte('paid_at', startIso)
    .lt('paid_at', endIso)
    .limit(5000)
  if (restaurantId) query = query.eq('restaurant_id', restaurantId)

  const { data, error } = await query
  if (error) return { byVenue, error: error.message }

  const cardPaid = (data ?? []).filter((o: PaidOrderRow) => {
    if (!isPaidPaymentStatus(o.payment_status)) return false
    // Cash is excluded from the ledger by design, so counting it here would report a
    // permanent, unfixable "gap" every hour and train everyone to ignore this alert.
    const method = String(o.payment_method ?? '').trim().toLowerCase()
    return method !== 'cash'
  }) as PaidOrderRow[]

  if (cardPaid.length === 0) return { byVenue, error: null }

  const { covered, error: coverageError } = await orderIdsWithSaleRows(
    supabase,
    cardPaid.map((o) => String(o.id)),
  )
  if (coverageError) return { byVenue, error: coverageError }

  for (const order of cardPaid) {
    const venue = String(order.restaurant_id)
    if (!byVenue.has(venue)) byVenue.set(venue, { paid: [], missing: [] })
    const entry = byVenue.get(venue)!
    entry.paid.push(String(order.id))
    if (!covered.has(String(order.id))) entry.missing.push(String(order.id))
  }

  return { byVenue, error: null }
}

export type ReconcileSaleLedgerCoverageOptions = {
  windowHours?: number
  now?: Date
  restaurantId?: string
  /** Skip the audit writes -- for read-only inspection. Never used by the cron. */
  dryRun?: boolean
}

export type ReconcileSaleLedgerCoverageResult = {
  ok: boolean
  error: string | null
  report: CoverageReport | null
}

/**
 * Hourly per-venue SALE coverage check.
 *
 * REPORTS. DOES NOT BLOCK. Nothing in this function gates a deploy, a request or a settlement,
 * and it must stay that way: it necessarily fires on pre-existing history -- 294 card payments
 * already have no SALE row -- and a new check that fires on old data and blocks something is
 * how monitoring gets switched off within the week.
 *
 * Never throws. A failure to run is itself recorded, because a reconciliation job that dies
 * quietly is worth less than no job at all: it looks like an all-clear.
 */
export async function reconcileSaleLedgerCoverage(
  supabase: Supabase,
  options: ReconcileSaleLedgerCoverageOptions = {},
): Promise<ReconcileSaleLedgerCoverageResult> {
  const windowHours = options.windowHours ?? 1
  const now = options.now ?? new Date()
  const windowMs = windowHours * 60 * 60 * 1000
  const end = now
  const start = new Date(end.getTime() - windowMs)
  const prevStart = new Date(start.getTime() - windowMs)

  try {
    const current = await collectWindow(
      supabase,
      start.toISOString(),
      end.toISOString(),
      options.restaurantId,
    )
    if (current.error) {
      return await failRun(supabase, options, `current window read failed: ${current.error}`)
    }

    const previous = await collectWindow(
      supabase,
      prevStart.toISOString(),
      start.toISOString(),
      options.restaurantId,
    )
    // The previous window only feeds the degradation rule. If it cannot be read the ratio rule
    // still stands on its own, so this degrades rather than aborting the run.
    if (previous.error) {
      console.warn(
        '[reconcile-sale-ledger-coverage] previous window unreadable; degradation rule disabled this run',
        previous.error,
      )
    }

    const venueIds = [...current.byVenue.keys()]
    const names = await venueNames(supabase, venueIds)

    const venues: VenueCoverage[] = venueIds.map((restaurantId) => {
      const cur = current.byVenue.get(restaurantId)!
      const prev = previous.error ? undefined : previous.byVenue.get(restaurantId)
      const paidCount = cur.paid.length
      const missingCount = cur.missing.length
      const previousPaidCount = prev?.paid.length ?? 0
      const previousMissingCount = prev?.missing.length ?? 0
      const previousMissingRatio =
        previousPaidCount > 0 ? previousMissingCount / previousPaidCount : null

      const { degraded, trigger } = assessVenueCoverage({
        paidCount,
        missingCount,
        previousMissingRatio,
      })

      return {
        restaurantId,
        restaurantName: names.get(restaurantId) ?? null,
        paidCount,
        missingCount,
        missingRatio: paidCount > 0 ? missingCount / paidCount : 0,
        previousPaidCount,
        previousMissingCount,
        previousMissingRatio,
        // Capped: the metadata is for pointing a human at the problem, not for holding the
        // full result set of a total outage.
        missingOrderIds: cur.missing.slice(0, 50),
        degraded,
        trigger,
      }
    })

    const report: CoverageReport = {
      windowHours,
      windowStart: start.toISOString(),
      windowEnd: end.toISOString(),
      venues,
      totals: {
        paidCount: venues.reduce((sum, v) => sum + v.paidCount, 0),
        missingCount: venues.reduce((sum, v) => sum + v.missingCount, 0),
        degradedVenues: venues.filter((v) => v.degraded).length,
      },
    }

    console.log(
      '[reconcile-sale-ledger-coverage] run complete',
      JSON.stringify({
        marker: SALE_LEDGER_RECONCILIATION_HEARTBEAT_ACTION,
        severity: report.totals.degradedVenues > 0 ? 'critical' : 'info',
        requiresAttention: report.totals.degradedVenues > 0,
        ...report.totals,
        windowHours,
        windowStart: report.windowStart,
        windowEnd: report.windowEnd,
        venues: venues.map((v) => ({
          restaurantId: v.restaurantId,
          name: v.restaurantName,
          paid: v.paidCount,
          missing: v.missingCount,
          degraded: v.degraded,
        })),
      }),
    )

    if (!options.dryRun) {
      await writeAudits(supabase, report)
    }

    return { ok: true, error: null, report }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return await failRun(supabase, options, reason)
  }
}

async function venueNames(
  supabase: Supabase,
  restaurantIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (restaurantIds.length === 0) return names
  const { data } = await supabase
    .from('restaurants')
    .select('id, name')
    .in('id', restaurantIds)
  for (const row of data ?? []) names.set(String(row.id), String(row.name ?? ''))
  return names
}

/**
 * Heartbeat per venue observed, plus a degraded row per venue that breached.
 *
 * Both are scoped to a real restaurant_id so this works whether or not audit_logs allows a
 * null one, and so the ops console can route each row to the venue it concerns -- the
 * Discovery Note's point that simultaneous failure across two venues is itself diagnostic.
 */
async function writeAudits(supabase: Supabase, report: CoverageReport): Promise<void> {
  const rows = report.venues.map((venue) => ({
    restaurant_id: venue.restaurantId,
    action: venue.degraded
      ? SALE_LEDGER_COVERAGE_DEGRADED_ACTION
      : SALE_LEDGER_RECONCILIATION_HEARTBEAT_ACTION,
    entity_type: 'payment_events',
    entity_id: null,
    metadata: {
      windowHours: report.windowHours,
      windowStart: report.windowStart,
      windowEnd: report.windowEnd,
      paidCount: venue.paidCount,
      missingCount: venue.missingCount,
      missingRatio: venue.missingRatio,
      previousPaidCount: venue.previousPaidCount,
      previousMissingCount: venue.previousMissingCount,
      previousMissingRatio: venue.previousMissingRatio,
      missingOrderIds: venue.missingOrderIds,
      trigger: venue.trigger,
      severity: venue.degraded ? 'critical' : 'info',
      requiresAttention: venue.degraded,
    },
  }))

  if (rows.length === 0) return

  const { error } = await supabase.from('audit_logs').insert(rows)
  if (error) {
    console.error(
      '[reconcile-sale-ledger-coverage] could not write reconciliation audit rows',
      JSON.stringify({
        marker: 'payment.sale_ledger_reconciliation_audit_failed',
        severity: 'critical',
        requiresAttention: true,
        error: error.message,
        venueCount: rows.length,
      }),
    )
  }
}

/** A run that could not complete is louder than a run that found nothing. */
async function failRun(
  supabase: Supabase,
  options: ReconcileSaleLedgerCoverageOptions,
  reason: string,
): Promise<ReconcileSaleLedgerCoverageResult> {
  console.error(
    '[reconcile-sale-ledger-coverage] run FAILED',
    JSON.stringify({
      marker: 'payment.sale_ledger_reconciliation_failed',
      severity: 'critical',
      requiresAttention: true,
      error: reason,
    }),
  )

  if (!options.dryRun && options.restaurantId) {
    // Only writable when the run was venue-scoped; the unscoped case has no restaurant_id to
    // attach and relies on the Worker log above, which #155 made durable.
    try {
      await supabase.from('audit_logs').insert({
        restaurant_id: options.restaurantId,
        action: SALE_LEDGER_RECONCILIATION_HEARTBEAT_ACTION,
        entity_type: 'payment_events',
        entity_id: null,
        metadata: { failed: true, error: reason, severity: 'critical', requiresAttention: true },
      })
    } catch {
      // Already reported above; nothing further to escalate to.
    }
  }

  return { ok: false, error: reason, report: null }
}
