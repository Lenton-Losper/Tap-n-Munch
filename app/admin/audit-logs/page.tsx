'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EmptyState } from '@/components/platform/ops-shell'
import { getAccessToken } from '@/lib/onboarding/api-client'

/**
 * Which audit stream a row came from. Not a column on either table -- withSource() below
 * stamps it as the two streams are merged, so these are the only two values that exist.
 */
type AuditSource = 'platform' | 'tenant'

type AuditRow = {
  id: string
  source?: AuditSource
  action: string
  actor_email?: string | null
  restaurant_id?: string | null
  restaurant_name?: string | null
  target_type?: string | null
  target_id?: string | null
  entity_type?: string | null
  entity_id?: string | null
  success?: boolean
  created_at: string
}

function withSource(rows: AuditRow[], source: AuditSource) {
  return rows.map((row) => ({ ...row, source: row.source || source }))
}

export default function AuditLogsPage() {
  const [rows, setRows] = useState<AuditRow[]>([])
  const [source, setSource] = useState('all')
  const [action, setAction] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (sourceFilter = 'all', actionFilter = '') => {
    try {
      const token = await getAccessToken()
      setLoading(true)
      setError('')
      if (!token) throw new Error('Not signed in')
      const params = new URLSearchParams()
      if (sourceFilter !== 'all') params.set('source', sourceFilter)
      if (actionFilter.trim()) params.set('action', actionFilter.trim())
      const response = await fetch(`/api/platform/audit-logs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Failed to load audit logs')
      const combined = Array.isArray(body.logs)
        ? body.logs
        : [
            ...withSource(body.platformAudits || body.platform || [], 'platform'),
            ...withSource(body.tenantAudits || body.tenant || [], 'tenant'),
          ]
      setRows(
        (combined as AuditRow[]).sort((a, b) =>
          String(b.created_at).localeCompare(String(a.created_at)),
        ),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load audit logs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => load())
  }, [load])

  const applyFilters = (event: FormEvent) => {
    event.preventDefault()
    void load(source, action)
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">Audit logs</h1>
        <p className="mt-1 text-sm text-[#8A867C]">
          Immutable platform administrator and tenant activity.
        </p>
      </div>

      <form
        onSubmit={applyFilters}
        className="grid gap-3 rounded-xl border border-[#E8E6E1] bg-white p-4 sm:grid-cols-[180px_1fr_auto]"
      >
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger className="border-[#E8E6E1]">
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="platform">Platform</SelectItem>
            <SelectItem value="tenant">Tenant</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={action}
          onChange={(event) => setAction(event.target.value)}
          placeholder="Filter action, e.g. alert_ack_updated"
          className="border-[#E8E6E1]"
        />
        <Button type="submit" className="bg-[#C0392B] text-white hover:bg-[#A93226]">
          Apply
        </Button>
      </form>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-[#8A867C]">Loading audit history…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="No audit entries" body="No records match the current filters." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead className="border-b border-[#E8E6E1] bg-[#FAFAF8] text-[11px] uppercase tracking-wide text-[#8A867C]">
                <tr>
                  <th className="px-4 py-3">Time</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Actor / restaurant</th>
                  <th className="px-4 py-3">Target</th>
                  <th className="px-4 py-3">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFEDE8]">
                {rows.map((row) => (
                  <tr key={`${row.source}-${row.id}`} className="align-top">
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-[#8A867C]">
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className="border-[#E8E6E1] text-[#5C574E]">
                        {row.source || 'tenant'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 font-medium text-[#1A1A1A]">{row.action}</td>
                    <td className="px-4 py-3 text-[#5C574E]">
                      {row.actor_email || row.restaurant_name || row.restaurant_id || 'system'}
                    </td>
                    <td className="px-4 py-3 text-[#5C574E]">
                      {row.restaurant_id ? (
                        <Link
                          href={`/admin/restaurants/${row.restaurant_id}?tab=audit`}
                          className="text-[#C0392B] hover:underline"
                        >
                          {row.target_type || row.entity_type || 'restaurant'}{' '}
                          {row.target_id || row.entity_id || ''}
                        </Link>
                      ) : (
                        `${row.target_type || row.entity_type || '—'} ${row.target_id || row.entity_id || ''}`
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {row.success === false ? (
                        <span className="text-red-700">Failed</span>
                      ) : (
                        <span className="text-emerald-700">Success</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
