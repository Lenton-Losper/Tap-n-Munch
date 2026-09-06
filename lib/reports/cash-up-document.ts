import type { ReportData } from './get-report-data'
import { cashUpReconciliation, cashUpRows } from './payment-method-split'
import {
  CASH_UP_GRATUITIES_HEADING,
  CASH_UP_GRATUITIES_NOTE,
  CASH_UP_GROSS_TAKEN,
  CASH_UP_HEADING,
  CASH_UP_ITEMS_HEADING,
  CASH_UP_LESS_REFUNDS,
  CASH_UP_NET_REVENUE,
  CASH_UP_NO_PAYMENTS,
  CASH_UP_NOT_A_TAX_INVOICE,
  CASH_UP_NOTHING_SOLD,
  CASH_UP_ORDERS,
  CASH_UP_PRINTED_BY,
  CASH_UP_TAKINGS_HEADING,
} from './cash-up-copy'
import {
  centered,
  DEFAULT_CHARACTER_WIDTH,
  divider,
  EscposBuilder,
  truncate,
  twoColumnLine,
} from '@/lib/receipts/renderers/thermal-primitives'

/**
 * THE END-OF-DAY CASH-UP, AS PRINTED ON THE TERMINAL'S OWN PRINTER.
 *
 * ================================================================================================
 * WHAT IT IS FOR
 * ================================================================================================
 *
 * A manager closing up, standing at the terminal with the drawer open. It answers, in this order:
 * what came in and how it was paid, what the till says the total was, what was sold, and what was
 * left as a gratuity. Everything on it is meant to be reconciled against something physical.
 *
 * ================================================================================================
 * TWO FORMATS, ONE LAYOUT, AND WHY
 * ================================================================================================
 *
 * The estate has two printer transports and neither can use the other's format: a paired Bluetooth
 * printer takes raw ESC/POS bytes, and the P5's built-in printer goes through WisePosSdk, which
 * has NO raw-byte write at all — it takes structured lines. That is already true of receipts
 * (escposRenderer / sdk6Renderer), and it is why this file renders twice from one set of rows
 * rather than rendering once and converting.
 *
 * `buildCashUpRows()` is that single set. Both renderers walk it. A figure can therefore be wrong,
 * but it cannot be DIFFERENT between the two printers in the same venue, which is the failure that
 * would be impossible to explain to somebody holding two pieces of paper.
 *
 * ================================================================================================
 * THE MONEY IS GROSS, AND THE BRIDGE IS PRINTED
 * ================================================================================================
 *
 * `paymentMethodSplit` is gross of refunds by construction (see get-report-data). `totalRevenue`
 * is net of them. A cash-up that showed the parts and the total without the step between them
 * looks like an arithmetic error to the one person it is for, so the bridge — gross taken, less
 * refunds, net — is printed rather than left to be worked out.
 */

export interface CashUpDocumentOptions {
  /** Characters per line for the paired printer (58mm ~32, 80mm ~48). Defaults to 32. */
  characterWidth?: number
  /** Who authorised the print, from the consumed PIN token. Never the device. */
  printedByName: string
  /** When the print was produced, ISO. */
  printedAt: string
  /** Human label for the period — "Today", "Yesterday", "This week". */
  periodLabel: string
  /** Gratuities in the period, major units. Absent until tips are live at this venue. */
  gratuityTotal?: number | null
  /** Number of gratuities in the period. Meaningless without gratuityTotal. */
  gratuityCount?: number | null
}

type Row =
  | { kind: 'title'; text: string }
  | { kind: 'meta'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'pair'; left: string; right: string; bold?: boolean }
  | { kind: 'divider' }
  | { kind: 'blank' }

const money = (n: number) => `N$${(Number.isFinite(n) ? n : 0).toFixed(2)}`
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
/** English, not an -s rule: "4 gratuitys" is what a naive pluraliser prints on a customer-facing slip. */
const gratuityCountLabel = (n: number) => `${n} ${n === 1 ? 'gratuity' : 'gratuities'}`

/**
 * The document as an ordered list of rows, format-independent.
 *
 * EXPORTED because it is what the tests assert against. Asserting on ESC/POS bytes would prove
 * nothing readable, and asserting on the SDK6 array would leave the Bluetooth path uncovered;
 * both walk this, so this is where the document actually lives.
 */
export function buildCashUpRows(report: ReportData, options: CashUpDocumentOptions): Row[] {
  const rows = cashUpRows(report)
  const recon = cashUpReconciliation(report)
  const out: Row[] = []

  out.push({ kind: 'title', text: CASH_UP_HEADING })
  out.push({ kind: 'meta', text: report.restaurant.name })
  out.push({ kind: 'meta', text: options.periodLabel })
  out.push({
    kind: 'meta',
    text:
      report.filters.startDate === report.filters.endDate
        ? report.filters.startDate
        : `${report.filters.startDate} to ${report.filters.endDate}`,
  })
  out.push({ kind: 'divider' })

  out.push({ kind: 'heading', text: CASH_UP_TAKINGS_HEADING })
  if (rows.length === 0) {
    // A quiet day is a real answer. An empty section reads as a broken print.
    out.push({ kind: 'pair', left: CASH_UP_NO_PAYMENTS, right: money(0) })
  } else {
    for (const row of rows) {
      out.push({
        kind: 'pair',
        left: `${row.label} (${plural(row.orders, 'order')})`,
        right: money(row.gross),
      })
    }
  }
  out.push({ kind: 'pair', left: CASH_UP_GROSS_TAKEN, right: money(recon.grossTaken), bold: true })
  if (recon.refunded > 0) {
    // Printed only when there were refunds. A "Less refunds N$0.00" line on an ordinary day is
    // noise on paper somebody has to read at the end of a shift.
    out.push({ kind: 'pair', left: CASH_UP_LESS_REFUNDS, right: money(-recon.refunded) })
  }
  out.push({ kind: 'pair', left: CASH_UP_NET_REVENUE, right: money(recon.net), bold: true })
  out.push({ kind: 'pair', left: CASH_UP_ORDERS, right: String(recon.orders) })

  /**
   * GRATUITIES, SEPARATE FROM TAKINGS AND SEPARATE FROM REVENUE.
   *
   * A gratuity is not consideration for the supply: it sits outside the VAT base and outside the
   * order total, in its own table, by construction. Adding it into "Gross taken" here would undo
   * that on the one document a venue reconciles against, so it is printed below the total and
   * never inside it.
   *
   * ABSENT MEANS NOT REPORTED, NOT ZERO. Until tips are live at a venue there is nothing to say,
   * and printing "Gratuities N$0.00" would tell a manager that nobody tipped — a claim this
   * document is in no position to make.
   */
  if (options.gratuityTotal != null) {
    out.push({ kind: 'divider' })
    out.push({ kind: 'heading', text: CASH_UP_GRATUITIES_HEADING })
    out.push({
      kind: 'pair',
      left: options.gratuityCount != null ? gratuityCountLabel(options.gratuityCount) : 'Total',
      right: money(options.gratuityTotal),
    })
    out.push({ kind: 'meta', text: CASH_UP_GRATUITIES_NOTE })
  }

  out.push({ kind: 'divider' })
  out.push({ kind: 'heading', text: CASH_UP_ITEMS_HEADING })
  if (report.summary.itemsSold.length === 0) {
    out.push({ kind: 'pair', left: CASH_UP_NOTHING_SOLD, right: '' })
  } else {
    for (const item of report.summary.itemsSold) {
      out.push({ kind: 'pair', left: `${item.quantity} x ${item.name}`, right: money(item.gross) })
    }
  }

  out.push({ kind: 'divider' })
  // WHO printed it, not which device. The PIN exists to put a name on this.
  out.push({ kind: 'meta', text: CASH_UP_PRINTED_BY.replace('{name}', options.printedByName) })
  out.push({ kind: 'meta', text: options.printedAt })
  out.push({ kind: 'meta', text: CASH_UP_NOT_A_TAX_INVOICE })

  return out
}

/** Raw ESC/POS bytes, for a paired Bluetooth printer. */
export function renderCashUpEscPos(
  report: ReportData,
  options: CashUpDocumentOptions,
): Uint8Array {
  const width = options.characterWidth ?? DEFAULT_CHARACTER_WIDTH
  const builder = new EscposBuilder().init()

  for (const row of buildCashUpRows(report, options)) {
    switch (row.kind) {
      case 'title':
        builder.align('center').bold(true).line(centered(row.text, width)).bold(false).align('left')
        break
      case 'meta':
        builder.align('center').line(centered(row.text, width)).align('left')
        break
      case 'heading':
        builder.bold(true).line(truncate(row.text, width)).bold(false)
        break
      case 'pair':
        if (row.bold) builder.bold(true)
        builder.line(twoColumnLine(row.left, row.right, width))
        if (row.bold) builder.bold(false)
        break
      case 'divider':
        builder.line(divider(width))
        break
      case 'blank':
        builder.line('')
        break
    }
  }

  return builder.feed(3).cut().build()
}

/** Structured lines, for the P5's built-in printer via WisePosSdk (no raw-byte write). */
export type Sdk6CashUpLine =
  | { type: 'text'; text: string; align: 'left' | 'center' | 'right'; bold?: boolean; large?: boolean }
  | { type: 'row'; columns: string[] }
  | { type: 'feed'; lines: number }
  | { type: 'divider' }

export function renderCashUpSdk6(
  report: ReportData,
  options: CashUpDocumentOptions,
): Sdk6CashUpLine[] {
  const out: Sdk6CashUpLine[] = []

  for (const row of buildCashUpRows(report, options)) {
    switch (row.kind) {
      case 'title':
        out.push({ type: 'text', text: row.text, align: 'center', bold: true, large: true })
        break
      case 'meta':
        out.push({ type: 'text', text: row.text, align: 'center' })
        break
      case 'heading':
        out.push({ type: 'text', text: row.text, align: 'left', bold: true })
        break
      case 'pair':
        // A 'row' lets the SDK do the column arithmetic against the real font metrics, which is
        // why this does NOT reuse twoColumnLine: pre-padding with spaces would fight it.
        out.push({ type: 'row', columns: [row.left, row.right] })
        break
      case 'divider':
        out.push({ type: 'divider' })
        break
      case 'blank':
        out.push({ type: 'feed', lines: 1 })
        break
    }
  }

  out.push({ type: 'feed', lines: 3 })
  return out
}
