'use client'

import { useEffect, useState } from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { DATE_RANGE_PRESETS, resolveDateRangePreset, type DateRangePresetId } from '@/lib/reports/date-range-presets'
import type { Breakdown, MethodRow, Section } from '@/lib/analytics/payment-method-breakdown'

/**
 * Payment method breakdown card. Settlement transactions first; the order-based figures for days
 * before the ledger is reliable sit in their own section and are never added to the first.
 * See lib/analytics/payment-method-breakdown.ts for what each number means.
 */

type Range = { startDate: string; endDate: string }
export type BreakdownLoader = (range: Range) => Promise<Breakdown>

const METHOD_COLORS: Record<string, string> = {
  card: '#FF6B35',
  cash: '#37352F',
  paytoday: '#2F7D6B',
  other: '#6B5FB5',
  unknown: '#9B9A97',
}
const UNRECOGNISED_COLOR = '#C4BBAF'
const colorFor = (m: MethodRow) => METHOD_COLORS[m.method] ?? UNRECOGNISED_COLOR

function money(cents: number, symbol: string) {
  const abs = (Math.abs(cents) / 100).toFixed(2)
  return `${cents < 0 ? '-' : ''}${symbol}${abs}`
}

function fetchBreakdown(restaurantId: string): BreakdownLoader {
  return async ({ startDate, endDate }) => {
    const qs = new URLSearchParams({ restaurantId, startDate, endDate })
    const res = await fetch(`/api/analytics/payment-methods?${qs.toString()}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `Failed to load payment methods (${res.status})`)
    return body as Breakdown
  }
}

function MethodTable({ section, symbol, countHeader }: { section: Section; symbol: string; countHeader: string }) {
  const pctSum = section.rows.reduce((s, r) => s + r.percentOfCount, 0)
  const amtSum = section.rows.reduce((s, r) => s + r.percentOfAmount, 0)
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-[#E9E9E7] text-xs uppercase tracking-wide text-[#6B675F]">
            <th className="py-2 pr-3">Method</th>
            <th className="py-2 pr-3 text-right">{countHeader}</th>
            <th className="py-2 pr-3 text-right">% of count</th>
            <th className="py-2 pr-3 text-right">Amount</th>
            <th className="py-2 text-right">% of amount</th>
          </tr>
        </thead>
        <tbody>
          {section.rows.map((r) => (
            <tr key={r.method} className="border-b border-[#F1F0EC] align-top">
              <td className="py-2 pr-3">
                <span className="inline-flex items-center gap-2 font-medium text-[#37352F]">
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: colorFor(r) }} aria-hidden />
                  {r.label}
                </span>
                {r.validation && <p className="mt-1 max-w-md text-xs text-[#8A5A00]">⚠ {r.validation}</p>}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{r.count}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{r.percentOfCount.toFixed(1)}%</td>
              <td className="py-2 pr-3 text-right tabular-nums">{money(r.amountCents, symbol)}</td>
              <td className="py-2 text-right tabular-nums">{r.percentOfAmount.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold text-[#37352F]">
            <td className="py-2 pr-3">Total</td>
            <td className="py-2 pr-3 text-right tabular-nums">{section.total.count}</td>
            <td className="py-2 pr-3 text-right tabular-nums">{pctSum.toFixed(1)}%</td>
            <td className="py-2 pr-3 text-right tabular-nums">{money(section.total.amountCents, symbol)}</td>
            <td className="py-2 text-right tabular-nums">{amtSum.toFixed(1)}%</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function SectionPie({ section }: { section: Section }) {
  if (section.rows.length === 0) return null
  return (
    <div className="h-52 w-full sm:w-52" role="img" aria-label="Share of transactions by payment method">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={section.rows} dataKey="count" nameKey="label" outerRadius={80} isAnimationActive={false}>
            {section.rows.map((r) => (
              <Cell key={r.method} fill={colorFor(r)} />
            ))}
          </Pie>
          <Tooltip />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}

function DailyTable({ section, symbol }: { section: Section; symbol: string }) {
  const methods = section.rows
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-[#E9E9E7] uppercase tracking-wide text-[#6B675F]">
            <th className="py-2 pr-3">Day</th>
            {methods.map((m) => (
              <th key={m.method} className="py-2 pr-3 text-right">
                {m.label}
              </th>
            ))}
            <th className="py-2 pr-3 text-right">Total</th>
            <th className="py-2 text-right">Refunds</th>
          </tr>
        </thead>
        <tbody>
          {section.daily.map((d) => (
            <tr key={d.day} className="border-b border-[#F1F0EC]">
              <td className="py-1.5 pr-3 font-medium text-[#37352F]">{d.day}</td>
              {methods.map((m) => {
                const c = d.byMethod[m.method]
                return (
                  <td key={m.method} className="py-1.5 pr-3 text-right tabular-nums text-[#37352F]">
                    {c ? `${c.count} · ${money(c.amountCents, symbol)}` : '—'}
                  </td>
                )
              })}
              <td className="py-1.5 pr-3 text-right font-medium tabular-nums">
                {d.total.count} · {money(d.total.amountCents, symbol)}
              </td>
              <td className={`py-1.5 text-right tabular-nums ${d.refunds.count ? 'text-[#B3261E]' : 'text-[#37352F]'}`}>
                {d.refunds.count ? `${d.refunds.count} · ${money(d.refunds.amountCents, symbol)}` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PaymentMethodBreakdown({
  restaurantId,
  currencySymbol,
  load,
  initialRange,
}: {
  restaurantId: string
  currencySymbol: string
  /** Replaces the network call; used by tests and the fixture preview. */
  load?: BreakdownLoader
  initialRange?: Range
}) {
  const [preset, setPreset] = useState<DateRangePresetId | 'custom'>(initialRange ? 'custom' : 'thisWeek')
  const [range, setRange] = useState<Range>(() => initialRange ?? resolveDateRangePreset('thisWeek'))
  const [data, setData] = useState<Breakdown | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const run = load ?? fetchBreakdown(restaurantId)
    const refresh = async () => {
      setLoading(true)
      setError(null)
      try {
        const b = await run(range)
        if (!cancelled) setData(b)
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void refresh()
    return () => {
      cancelled = true
    }
  }, [restaurantId, range, load])

  const s = data?.settlement ?? null
  const pre = data?.preLedger ?? null
  const cov = data?.coverage

  return (
    <div className="rounded-2xl border border-[#E9E9E7] bg-white p-5" data-testid="payment-method-breakdown">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div>
          <h3 className="font-serif text-xl text-[#37352F]">Payment Method Breakdown</h3>
          <p className="mt-1 text-xs text-[#6B675F]">
            {range.startDate} to {range.endDate} · days in {data?.timeZone ?? 'venue time zone'} · by time collected
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {DATE_RANGE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setPreset(p.id)
                setRange(resolveDateRangePreset(p.id, { timeZone: data?.timeZone }))
              }}
              className={`rounded-full border px-3 py-1 text-xs ${
                preset === p.id ? 'border-[#FF6B35] bg-[#FFF0E9] text-[#C74F22]' : 'border-[#E9E9E7] text-[#6B675F]'
              }`}
            >
              {p.label}
            </button>
          ))}
          <input
            type="date"
            aria-label="From date"
            value={range.startDate}
            max={range.endDate}
            onChange={(e) => e.target.value && (setPreset('custom'), setRange({ ...range, startDate: e.target.value }))}
            className="rounded-md border border-[#E9E9E7] px-2 py-1 text-xs"
          />
          <input
            type="date"
            aria-label="To date"
            value={range.endDate}
            min={range.startDate}
            onChange={(e) => e.target.value && (setPreset('custom'), setRange({ ...range, endDate: e.target.value }))}
            className="rounded-md border border-[#E9E9E7] px-2 py-1 text-xs"
          />
        </div>
      </div>

      {error && <p className="mt-4 rounded-lg bg-[#FDECEA] p-3 text-sm text-[#B3261E]">{error}</p>}
      {loading && !data && <div className="mt-4 h-40 animate-pulse rounded-xl bg-[#F7F6F3]" />}

      {data && (
        <div className={loading ? 'opacity-60' : ''}>
          {data.cutOverDay && (
            <p className="mt-4 rounded-lg bg-[#FFF7E0] p-3 text-xs text-[#8A5A00]">
              {data.cutOverDay} is the day the settlement ledger started and is only partly recorded, so it is shown
              order-based below, not as settlement transactions.
            </p>
          )}

          {s && (
            <section className="mt-5" aria-label="Settlement transactions">
              <h4 className="text-sm font-semibold text-[#37352F]">
                Settlement transactions · {s.startDate} to {s.endDate}
              </h4>
              <p className="mt-1 text-xs text-[#6B675F]">
                Percentages are of <strong>{s.denominatorLabel}</strong>. Amounts include any gratuity collected.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-[#E9E9E7] p-3">
                  <p className="text-xs text-[#6B675F]">Transactions</p>
                  <p className="text-xl font-semibold tabular-nums text-[#37352F]">{s.total.count}</p>
                </div>
                <div className="rounded-xl border border-[#E9E9E7] p-3">
                  <p className="text-xs text-[#6B675F]">Collected</p>
                  <p className="text-xl font-semibold tabular-nums text-[#37352F]">
                    {money(s.total.amountCents, currencySymbol)}
                  </p>
                </div>
                <div className="rounded-xl border border-[#E9E9E7] p-3">
                  <p className="text-xs text-[#6B675F]">Orders covered (not a transaction count)</p>
                  <p className="text-xl font-semibold tabular-nums text-[#37352F]">{s.total.ordersCovered}</p>
                </div>
                <div className="rounded-xl border border-[#E9E9E7] p-3">
                  <p className="text-xs text-[#6B675F]">Refunds (separate)</p>
                  <p className="text-xl font-semibold tabular-nums text-[#B3261E]">
                    {data.refunds.count} · {money(data.refunds.amountCents, currencySymbol)}
                  </p>
                </div>
              </div>

              {s.rows.length === 0 ? (
                <p className="mt-4 text-sm text-[#6B675F]">No settlement transactions in this period.</p>
              ) : (
                <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
                  <SectionPie section={s} />
                  <div className="flex-1">
                    <MethodTable section={s} symbol={currencySymbol} countHeader="Transactions" />
                  </div>
                </div>
              )}
              <DailyTable section={s} symbol={currencySymbol} />
            </section>
          )}

          {cov && cov.uncoveredOrders > 0 && (
            <div className="mt-4 rounded-lg border border-[#F2D58A] bg-[#FFF7E0] p-3 text-sm text-[#6B4A00]" role="alert">
              <strong>
                {cov.uncoveredOrders} paid order{cov.uncoveredOrders === 1 ? '' : 's'} (
                {money(cov.uncoveredAmountCents, currencySymbol)}) have no settlement record
              </strong>{' '}
              ({cov.firstDay} to {cov.lastDay}) and are <em>not</em> in the totals above. By the method on the order:{' '}
              {Object.entries(cov.byOrderMethod)
                .map(([m, v]) => `${m} ${v.orders}`)
                .join(', ')}
              .
            </div>
          )}
          {cov && cov.settledOutsideRange > 0 && (
            <p className="mt-2 text-xs text-[#6B675F]">
              {cov.settledOutsideRange} order{cov.settledOutsideRange === 1 ? ' was' : 's were'} paid in this period but
              their settlement is dated outside it; they are counted in that other day&apos;s totals.
            </p>
          )}
          {data.refundsBeforeLedger.count > 0 && (
            <p className="mt-2 text-xs text-[#6B675F]">
              Also {data.refundsBeforeLedger.count} refund{data.refundsBeforeLedger.count === 1 ? '' : 's'} (
              {money(data.refundsBeforeLedger.amountCents, currencySymbol)}) on days before the ledger is reliable.
            </p>
          )}

          {pre && (
            <section className="mt-6 rounded-xl border border-dashed border-[#C4BBAF] p-4" aria-label="Order-based, before the ledger">
              <h4 className="text-sm font-semibold text-[#37352F]">
                Order-based · {pre.startDate} to {pre.endDate} (before the settlement ledger is reliable)
              </h4>
              <p className="mt-1 text-xs text-[#6B675F]">
                Counts <strong>paid orders</strong> by the method recorded on the order, not settlement transactions.
                Percentages are of <strong>{pre.denominatorLabel}</strong>. Not added to the figures above.
              </p>
              {pre.rows.length === 0 ? (
                <p className="mt-3 text-sm text-[#6B675F]">No paid orders in this period.</p>
              ) : (
                <div className="mt-3">
                  <MethodTable section={pre} symbol={currencySymbol} countHeader="Orders" />
                </div>
              )}
            </section>
          )}

          {data.rowsWithoutValidTimestamp > 0 && (
            <p className="mt-3 text-xs text-[#B3261E]">
              {data.rowsWithoutValidTimestamp} record{data.rowsWithoutValidTimestamp === 1 ? '' : 's'} had no usable
              timestamp and could not be placed on a day.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
