'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EmptyState } from '@/components/platform/ops-shell'
import { getAccessToken } from '@/lib/onboarding/api-client'

type BugReport = {
  id: string
  restaurant_id?: string | null
  restaurant_name?: string | null
  restaurants?: { name?: string } | Array<{ name?: string }> | null
  area?: string | null
  description: string
  status?: BugReportStatus | null
  created_at: string
}

const FILTERS = ['all', 'open', 'in_progress', 'resolved', 'closed'] as const
const STATUS_OPTIONS = ['open', 'in_progress', 'resolved', 'closed'] as const

/**
 * The four values bug_reports.status can hold. Enforced in the database by
 * CHECK (status IN ('open','in_progress','resolved','closed')), added in
 * 20260724180000_platform_ops_console.sql, so this union is not a guess about the
 * column -- it is the column.
 */
type BugReportStatus = (typeof STATUS_OPTIONS)[number]

function restaurantName(report: BugReport) {
  const relation = Array.isArray(report.restaurants) ? report.restaurants[0] : report.restaurants
  return report.restaurant_name || relation?.name || 'Unknown restaurant'
}

export default function BugReportsPage() {
  const [reports, setReports] = useState<BugReport[]>([])
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all')
  const [highlightId, setHighlightId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [updating, setUpdating] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const token = await getAccessToken()
      setLoading(true)
      setError('')
      if (!token) throw new Error('Not signed in')
      const response = await fetch('/api/platform/bug-reports', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Failed to load bug reports')
      setReports(
        Array.isArray(body.bugReports)
          ? body.bugReports
          : Array.isArray(body.reports)
            ? body.reports
            : Array.isArray(body.bugs)
              ? body.bugs
              : [],
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load bug reports')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => {
      setHighlightId(new URLSearchParams(window.location.search).get('id') || '')
      return load()
    })
  }, [load])

  const setStatus = async (id: string, status: BugReportStatus) => {
    setUpdating(id)
    setError('')
    try {
      const token = await getAccessToken()
      if (!token) throw new Error('Not signed in')
      const response = await fetch('/api/platform/bug-reports', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id, status }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Failed to update report')
      setReports((current) =>
        current.map((report) => (report.id === id ? { ...report, status } : report)),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to update report')
    } finally {
      setUpdating(null)
    }
  }

  const visible = reports.filter(
    (report) => filter === 'all' || (report.status || 'open') === filter,
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">Bug reports</h1>
        <p className="mt-1 text-sm text-[#8A867C]">
          Triage issues submitted by restaurants and terminal users.
        </p>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-[#E8E6E1]">
        {FILTERS.map((item) => (
          <button
            type="button"
            key={item}
            onClick={() => setFilter(item)}
            className={`border-b-2 px-3 py-2 text-sm font-medium capitalize ${
              filter === item
                ? 'border-[#C0392B] text-[#1A1A1A]'
                : 'border-transparent text-[#8A867C]'
            }`}
          >
            {item.replace('_', ' ')}
          </button>
        ))}
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-[#8A867C]">Loading bug reports…</p>
      ) : visible.length === 0 ? (
        <EmptyState title="No bug reports" body="No reports match the selected status." />
      ) : (
        <div className="grid gap-3">
          {visible.map((report) => {
            const highlighted = report.id === highlightId
            return (
              <article
                id={`bug-${report.id}`}
                key={report.id}
                className={`rounded-xl border bg-white p-5 transition ${
                  highlighted
                    ? 'border-[#C0392B] ring-2 ring-[#C0392B]/15'
                    : 'border-[#E8E6E1]'
                }`}
              >
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold text-[#1A1A1A]">
                        {restaurantName(report)}
                      </h2>
                      <Badge variant="outline" className="border-[#E8E6E1] text-[#5C574E]">
                        {report.area || 'General'}
                      </Badge>
                      {highlighted ? (
                        <Badge className="bg-[#C0392B] text-white">Linked report</Badge>
                      ) : null}
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[#5C574E]">
                      {report.description}
                    </p>
                    <div className="mt-3 flex gap-3 text-xs text-[#8A867C]">
                      <span>{new Date(report.created_at).toLocaleString()}</span>
                      {report.restaurant_id ? (
                        <Link
                          href={`/admin/restaurants/${report.restaurant_id}`}
                          className="font-medium text-[#C0392B] hover:underline"
                        >
                          View restaurant
                        </Link>
                      ) : null}
                    </div>
                  </div>
                  <Select
                    value={report.status || 'open'}
                    disabled={updating === report.id}
                    // Radix hands back a bare string, but every SelectItem below is
                    // rendered from STATUS_OPTIONS, so the value is a BugReportStatus
                    // by construction. This is the single narrowing point.
                    onValueChange={(status) => void setStatus(report.id, status as BugReportStatus)}
                  >
                    <SelectTrigger className="w-40 border-[#E8E6E1] bg-white capitalize">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((status) => (
                        <SelectItem key={status} value={status} className="capitalize">
                          {status.replace('_', ' ')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
