/**
 * @jest-environment jsdom
 *
 * The Payment Method Breakdown card as rendered: legend, labels, totals and percentages must be the
 * aggregation's numbers, with nothing dropped on the way to the screen (the original chart rendered
 * two slices and silently omitted "other").
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PaymentMethodBreakdown } from '@/components/analytics/payment-method-breakdown'
import { FIXTURE_RANGE, fixtureBreakdown } from './fixtures/payment-method-breakdown'

// jsdom has no layout, so the real chart renders nothing; the table is the artefact under test.
jest.mock('recharts', () => {
  const Stub = ({ children }: { children?: unknown }) => <div>{children as never}</div>
  return { ResponsiveContainer: Stub, PieChart: Stub, Pie: Stub, Cell: () => null, Tooltip: () => null }
})
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const breakdown = fixtureBreakdown()

async function mount(load = async () => breakdown) {
  await act(async () => {
    root.render(
      <PaymentMethodBreakdown restaurantId="r1" currencySymbol="N$" load={load} initialRange={FIXTURE_RANGE} />,
    )
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const section = (label: string) => host.querySelector(`section[aria-label="${label}"]`) as HTMLElement
const cells = (row: Element) => [...row.querySelectorAll('td')].map((c) => c.textContent?.trim() ?? '')

describe('Payment Method Breakdown card', () => {
  it('renders a row for every method in the data, including other, paytoday and the unrecognised one', async () => {
    await mount()
    const table = section('Settlement transactions').querySelector('table')!
    const labels = [...table.querySelectorAll('tbody tr')].map((r) => cells(r)[0])
    const expected = breakdown.settlement!.rows.map((r) => r.label)
    expect(labels.map((l) => l.replace(/^⚠.*/, ''))).toEqual(expect.arrayContaining(expected.map((e) => expect.stringContaining(e))))
    for (const must of ['Card', 'Cash', 'PayToday', 'Other', 'voucher (unrecognised)']) {
      expect(table.textContent).toContain(must)
    }
  })

  it('the table body sums to the Total row for count, percent-of-count, amount and percent-of-amount', async () => {
    await mount()
    const table = section('Settlement transactions').querySelector('table')!
    const body = [...table.querySelectorAll('tbody tr')].map(cells)
    const total = cells(table.querySelector('tfoot tr')!)
    const num = (s: string) => Number(s.replace(/[^0-9.-]/g, ''))
    expect(body.reduce((s, c) => s + num(c[1]), 0)).toBe(num(total[1]))
    expect(Math.round(body.reduce((s, c) => s + num(c[2]), 0) * 10)).toBe(1000)
    expect(total[2]).toBe('100.0%')
    expect(total[4]).toBe('100.0%')
    expect(Math.round(body.reduce((s, c) => s + num(c[3]), 0) * 100)).toBe(Math.round(num(total[3]) * 100))
    expect(num(total[1])).toBe(breakdown.settlement!.total.count)
  })

  it('labels the percentage denominator and keeps orders covered apart from transactions', async () => {
    await mount()
    const s = section('Settlement transactions').textContent!
    expect(s).toContain(breakdown.settlement!.denominatorLabel)
    expect(s).toContain('Orders covered (not a transaction count)')
    expect(breakdown.settlement!.total.ordersCovered).not.toBe(breakdown.settlement!.total.count)
  })

  it('shows refunds as a separate negative figure that is not in the table', async () => {
    await mount()
    const text = host.textContent!
    expect(text).toContain(`${breakdown.refunds.count} · -N$35.00`)
    expect(section('Settlement transactions').querySelector('table')!.textContent).not.toContain('-N$35.00')
  })

  it('warns about paid orders with no settlement record, with the count, and excludes them', async () => {
    await mount()
    const alert = host.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain(`${breakdown.coverage.uncoveredOrders} paid orders`)
    expect(alert.textContent).toContain('not in the totals above')
  })

  it('keeps the order-based section separate, labelled, and flags the partial cut-over day', async () => {
    await mount()
    const pre = section('Order-based, before the ledger')
    expect(pre.textContent).toContain('paid orders')
    expect(pre.textContent).toContain('Not added to the figures above')
    expect(host.textContent).toContain(`${breakdown.cutOverDay} is the day the settlement ledger started`)
    expect(section('Settlement transactions').textContent).not.toContain('Order-based')
  })

  it('flags "Other" for validation with its date span and does not call it test traffic', async () => {
    await mount()
    const text = section('Settlement transactions').textContent!
    expect(text).toMatch(/Staff-recorded "Other": \d+ from 2026-10-07 to 2026-10-11/)
    expect(text).toContain('Not classified as real or test traffic')
  })

  it('shows a daily row for every day, with a count and an amount per method', async () => {
    await mount()
    const rows = section('Settlement transactions').querySelectorAll('table')[1].querySelectorAll('tbody tr')
    expect(rows).toHaveLength(breakdown.settlement!.daily.length)
    expect(rows[0].textContent).toMatch(/\d+ · N\$\d+\.\d{2}/)
  })

  it('states the selected range and time zone', async () => {
    await mount()
    expect(host.textContent).toContain('2026-09-28 to 2026-10-11')
    expect(host.textContent).toContain('Africa/Windhoek')
  })

  it('shows an empty-period message, not a blank card', async () => {
    const emptyData = {
      ...breakdown,
      settlement: { ...breakdown.settlement!, rows: [], total: { count: 0, amountCents: 0, ordersCovered: 0 } },
      preLedger: null,
      coverage: { ...breakdown.coverage, uncoveredOrders: 0 },
      cutOverDay: null,
    }
    await mount(async () => emptyData)
    expect(host.textContent).toContain('No settlement transactions in this period.')
  })

  it('surfaces a load failure instead of an empty chart', async () => {
    await mount(async () => {
      throw new Error('boom')
    })
    expect(host.textContent).toContain('boom')
  })
})
