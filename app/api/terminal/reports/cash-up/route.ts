/**
 * POST /api/terminal/reports/cash-up — the end-of-day cash-up, rendered for the terminal's printer.
 *
 * ============================================================================================
 * THE FIRST TERMINAL ROUTE GATED ON A PIN FOR A READ
 * ============================================================================================
 *
 * Every other `privileged_authorization_tokens` purpose guards a write: a refund, a walkout, a
 * void. This one guards a READ, and the reason is the hardware rather than the data. A P5 sits on
 * a bar counter for a whole service, unlocked, and this document is the day's money — cash and
 * card, gross, order counts, everything sold. That is not something whoever picks the device up
 * should be able to produce by tapping a tile.
 *
 * IT IS NOT ON THE TERMINAL JWT, DELIBERATELY. That token belongs to the DEVICE and carries
 * orders:read / orders:update / tables:read at every venue in the estate. Widening it would grant
 * the day's takings to every terminal on the next refresh, including venues that never asked. The
 * PIN maps to `reports:cash_up` — manager and owner — and produces a users.id, which is printed on
 * the paper. A cash-up is the start of somebody being accountable for a drawer, so it says who.
 *
 * ============================================================================================
 * PRESETS ONLY. NO ARBITRARY RANGE.
 * ============================================================================================
 *
 * Today, Yesterday, This week — resolved in the VENUE's timezone, not the device's and not UTC.
 * A hand-rolled touchscreen date picker for a P5 is disproportionate to the ask, and "today" is
 * what a cash-up is for. Anyone needing an arbitrary period uses the dashboard export, which
 * carries the same split. Owner's ruling, 2026-09-07.
 *
 * THE ALLOW-LIST IS HERE AND NOT ON THE CLIENT. `resolveDateRangePreset` knows six presets; this
 * route accepts three. A terminal asking for `thisYear` is refused rather than served, because the
 * argument for presets is about what this document is, not about what the picker happens to show.
 *
 * ============================================================================================
 * IT RENDERS. IT DOES NOT PRINT, AND IT WRITES NOTHING.
 * ============================================================================================
 *
 * Same division as receipts: the server composes the document, the device pushes bytes at a
 * printer. Both formats come back because the two transports cannot use each other's — Bluetooth
 * takes raw ESC/POS, and the P5's built-in printer goes through WisePosSdk, which has no raw-byte
 * write.
 *
 * No row is inserted anywhere. The token is consumed (which is itself recorded, in
 * authorization_events) and nothing else changes, so a failed print is a reprint and never a
 * correction.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'
import { consumeAuthorizationToken } from '@/lib/terminal-auth/consume-authorization-token'
import { getReportData } from '@/lib/reports/get-report-data'
import { getGratuityReport } from '@/lib/reports/gratuity-report'
import { resolveDateRangePreset, type DateRangePresetId } from '@/lib/reports/date-range-presets'
import {
  calendarDateRangeToUtcIso,
  DEFAULT_REPORT_TIMEZONE,
} from '@/lib/reports/format-report-datetime'
import {
  renderCashUpEscPos,
  renderCashUpSdk6,
  type CashUpDocumentOptions,
} from '@/lib/reports/cash-up-document'

export const dynamic = 'force-dynamic'

/**
 * The three the terminal may ask for. NOT `DATE_RANGE_PRESETS`, which carries six: this is the
 * document's own allow-list, and it is enforced server-side so a client cannot widen it.
 */
const TERMINAL_PRESETS: Record<string, { id: DateRangePresetId; label: string }> = {
  today: { id: 'today', label: 'Today' },
  yesterday: { id: 'yesterday', label: 'Yesterday' },
  thisWeek: { id: 'thisWeek', label: 'This week' },
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export async function POST(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const body = (await req.json().catch(() => ({}))) as {
      preset?: unknown
      staff_user_id?: unknown
      authorization_token_id?: unknown
      character_width?: unknown
    }

    const presetKey = String(body.preset ?? '').trim()
    const preset = TERMINAL_PRESETS[presetKey]
    if (!preset) {
      return NextResponse.json(
        {
          error: 'Choose Today, Yesterday or This week.',
          code: 'INVALID_PRESET',
          allowed: Object.keys(TERMINAL_PRESETS),
        },
        { status: 400 },
      )
    }

    const staffUserId = String(body.staff_user_id ?? '').trim()
    const authorizationTokenId = String(body.authorization_token_id ?? '').trim()
    if (!staffUserId || !authorizationTokenId) {
      return NextResponse.json(
        {
          error: 'Printing the cash-up needs a manager or owner PIN. Authorize and try again.',
          code: 'CASH_UP_NEEDS_AUTHORIZATION',
        },
        { status: 403 },
      )
    }
    if (!isUuid(staffUserId) || !isUuid(authorizationTokenId)) {
      return NextResponse.json(
        { error: 'Authorization could not be verified', code: 'AUTHORIZATION_INVALID' },
        { status: 403 },
      )
    }

    /**
     * FAILS CLOSED on a thrown error as well as a rejected token. Consuming also writes an
     * authorization_events row, and letting that escape would answer 401 — which the terminal
     * reads as an expired session and would evict a device mid-service over a report.
     */
    let consumed: Awaited<ReturnType<typeof consumeAuthorizationToken>>
    try {
      consumed = await consumeAuthorizationToken(supabase, {
        tokenId: authorizationTokenId,
        expectedUserId: staffUserId,
        expectedRestaurantId: terminal.restaurantId,
        expectedTerminalId: terminal.terminalId,
        expectedPurpose: 'cash_up',
      })
    } catch (authErr) {
      console.error('[terminal/reports/cash-up] authorization check failed', authErr)
      consumed = { ok: false, reason: 'not_found' }
    }

    if (!consumed.ok) {
      return NextResponse.json(
        {
          error: 'Authorization could not be verified',
          code: 'AUTHORIZATION_INVALID',
          reason: consumed.reason,
        },
        { status: 403 },
      )
    }

    // The venue's own clock, never the device's. A terminal with a wrong timezone must not be able
    // to print a different day's takings than the dashboard reports for the same date.
    const { data: restaurantRow } = await supabase
      .from('restaurants')
      .select('timezone')
      .eq('id', terminal.restaurantId)
      .maybeSingle()
    const timezone =
      typeof restaurantRow?.timezone === 'string' && restaurantRow.timezone.trim()
        ? restaurantRow.timezone.trim()
        : DEFAULT_REPORT_TIMEZONE

    const range = resolveDateRangePreset(preset.id, { timeZone: timezone })

    const report = await getReportData({
      restaurantId: terminal.restaurantId,
      startDate: range.startDate,
      endDate: range.endDate,
    })

    /**
     * GRATUITIES, READ THROUGH THE SAME WINDOW as the takings so the two halves of one piece of
     * paper cannot describe different days.
     *
     * A FAILURE HERE OMITS THE SECTION RATHER THAN FAILING THE PRINT. The tips table does not
     * exist at every venue yet, and a manager who cannot close up because a feature they do not
     * use is unavailable is a worse outcome than a cash-up with no gratuity line. Absent is
     * rendered as "not reported", never as zero — see cash-up-document.
     */
    let gratuityTotal: number | null = null
    let gratuityCount: number | null = null
    try {
      const { startIso, endIsoExclusive } = calendarDateRangeToUtcIso(
        range.startDate,
        range.endDate,
        timezone,
      )
      const gratuities = await getGratuityReport(supabase, {
        restaurantId: terminal.restaurantId,
        fromIso: startIso,
        toIso: endIsoExclusive,
      })
      gratuityTotal = gratuities.total
      gratuityCount = gratuities.tipCount
    } catch (gratuityErr) {
      console.error('[terminal/reports/cash-up] gratuity read failed', gratuityErr)
    }

    /**
     * WHOSE NAME GOES ON THE PAPER.
     *
     * Read from `users` by the id the CONSUMED TOKEN was bound to — never from the request body.
     * The body's staff_user_id was only trusted far enough to be checked against the token; using
     * it for the name as well would let a caller print somebody else's name on a document whose
     * whole purpose is saying who produced it.
     *
     * A missing name falls back to a label rather than blank or an id: the line is meant to be
     * read by a person reconciling a drawer, and a bare uuid tells them nothing.
     */
    const { data: printedByRow } = await supabase
      .from('users')
      .select('full_name, name')
      .eq('id', staffUserId)
      .maybeSingle()
    const printedByName =
      String(printedByRow?.full_name ?? '').trim() ||
      String(printedByRow?.name ?? '').trim() ||
      'Manager'

    const characterWidth = Number(body.character_width)
    const options: CashUpDocumentOptions = {
      characterWidth:
        Number.isFinite(characterWidth) && characterWidth > 0 ? characterWidth : undefined,
      printedByName,
      printedAt: new Date().toISOString(),
      periodLabel: preset.label,
      gratuityTotal,
      gratuityCount,
    }

    return NextResponse.json({
      period: { preset: preset.id, label: preset.label, ...range, timezone },
      summary: {
        paymentMethodSplit: report.summary.paymentMethodSplit,
        totalRevenue: report.summary.totalRevenue,
        totalOrders: report.summary.totalOrders,
        refundedTotal: report.summary.refundedTotal,
        itemsSold: report.summary.itemsSold,
        gratuityTotal,
        gratuityCount,
      },
      escposBase64: Buffer.from(renderCashUpEscPos(report, options)).toString('base64'),
      sdk6Lines: renderCashUpSdk6(report, options),
    })
  } catch (error) {
    if (error instanceof Response) return error
    console.error('[terminal/reports/cash-up] failed', error)
    return NextResponse.json({ error: 'Failed to build the cash-up' }, { status: 500 })
  }
}
