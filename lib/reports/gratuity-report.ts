/**
 * GRATUITIES OVER A PERIOD, BY STAFF MEMBER.
 *
 * ============================================================================================
 * THIS IS NOT REVENUE AND MUST NEVER BE ADDED TO IT
 * ============================================================================================
 *
 * `getReportData().summary.totalRevenue` is derived from ORDERS, and a gratuity is not a sale.
 * This report reads `payment_tips` and nothing else, so the two figures cannot contaminate each
 * other by construction rather than by a filter someone could remove. Putting gratuities into a
 * turnover figure is a deliberate change somebody has to ask for.
 *
 * See supabase/migrations/20260905120000_payment_tips.sql for why a voluntary gratuity is outside
 * the VAT base, and why a compulsory service charge could never be recorded here.
 *
 * ============================================================================================
 * WHAT THE FIGURES MEAN, AND WHAT THEY DO NOT
 * ============================================================================================
 *
 * ATTRIBUTION IS THE SETTLER, and it is an UNVERIFIED claim: a picker on the terminal with no PIN
 * behind it. Anyone holding the terminal can pick anyone. A mis-tap puts one person's gratuity
 * against another's name, and this report will faithfully repeat it — so it is a record of what
 * was keyed, not proof of who earned what. That distinction belongs on the screen as well as here.
 *
 * POOLING IS NOT MODELLED. If a venue shares tips out, they share out what this reports. FlashTap
 * has no opinion about how, and adding one here would be inventing payroll policy.
 *
 * INTEGER CENTS THROUGHOUT. The ledger stores cents; this sums cents and converts once, at the
 * edge. Summing currency floats across a month is how a report drifts from the ledger it claims
 * to describe.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type GratuityByStaff = {
  staffUserId: string
  /** Display name, or a stable fallback — never a blank row. */
  name: string
  tipCount: number
  totalCents: number
  /** Convenience for rendering; derived from totalCents, never stored. */
  total: number
}

export type GratuityReport = {
  from: string
  to: string
  totalCents: number
  total: number
  tipCount: number
  /** Descending by amount: the question is "who took what", so the biggest answers first. */
  byStaff: GratuityByStaff[]
  /** Cash vs card, because a venue reconciles them differently. */
  byMethod: { method: string; totalCents: number; total: number; tipCount: number }[]
}

const toMajor = (cents: number) => Math.round(cents) / 100

/**
 * A staff member with no name is still a real row of money.
 *
 * Dropping them would make the total disagree with the sum of its parts, which is worse than an
 * ugly label — a report whose rows do not add up to its own total is one nobody trusts again.
 */
function displayName(name: string | null | undefined, userId: string): string {
  const trimmed = String(name ?? '').trim()
  if (trimmed) return trimmed
  return `Unknown staff (${userId.slice(0, 8)})`
}

export async function getGratuityReport(
  supabase: SupabaseClient,
  params: { restaurantId: string; fromIso: string; toIso: string },
): Promise<GratuityReport> {
  const { data, error } = await supabase
    .from('payment_tips')
    .select('tip_cents, method, staff_user_id, users:staff_user_id(full_name, name)')
    .eq('restaurant_id', params.restaurantId)
    .gte('recorded_at', params.fromIso)
    .lt('recorded_at', params.toIso)

  if (error) throw new Error(`getGratuityReport: ${error.message}`)

  const rows = (data ?? []) as Array<{
    tip_cents: number
    method: string
    staff_user_id: string
    users: { full_name: string | null; name: string | null } | Array<{ full_name: string | null; name: string | null }> | null
  }>

  const byStaff = new Map<string, GratuityByStaff>()
  const byMethod = new Map<string, { method: string; totalCents: number; tipCount: number }>()
  let totalCents = 0

  for (const row of rows) {
    const cents = Number(row.tip_cents) || 0
    totalCents += cents

    const joined = Array.isArray(row.users) ? row.users[0] : row.users
    const staffId = String(row.staff_user_id)
    const existing = byStaff.get(staffId)
    if (existing) {
      existing.tipCount += 1
      existing.totalCents += cents
      existing.total = toMajor(existing.totalCents)
    } else {
      byStaff.set(staffId, {
        staffUserId: staffId,
        name: displayName(joined?.full_name ?? joined?.name, staffId),
        tipCount: 1,
        totalCents: cents,
        total: toMajor(cents),
      })
    }

    const method = String(row.method || 'unknown')
    const m = byMethod.get(method)
    if (m) {
      m.tipCount += 1
      m.totalCents += cents
    } else {
      byMethod.set(method, { method, totalCents: cents, tipCount: 1 })
    }
  }

  return {
    from: params.fromIso,
    to: params.toIso,
    totalCents,
    total: toMajor(totalCents),
    tipCount: rows.length,
    byStaff: [...byStaff.values()].sort((a, b) => b.totalCents - a.totalCents),
    byMethod: [...byMethod.values()]
      .map((m) => ({ ...m, total: toMajor(m.totalCents) }))
      .sort((a, b) => b.totalCents - a.totalCents),
  }
}
