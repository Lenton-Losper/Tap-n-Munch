'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { EmptyState, HealthBadge } from '@/components/platform/ops-shell'
import { getAccessToken } from '@/lib/onboarding/api-client'

type Terminal = {
  id: string
  restaurant_id?: string
  restaurant_name?: string | null
  restaurants?: { name?: string } | Array<{ name?: string }> | null
  terminal_name?: string | null
  name?: string | null
  sn?: string | null
  device_serial?: string | null
  app_version?: string | null
  last_seen?: string | null
  last_seen_at?: string | null
  online?: boolean
  active?: boolean
  status?: string
}

function relatedName(terminal: Terminal) {
  const relation = Array.isArray(terminal.restaurants)
    ? terminal.restaurants[0]
    : terminal.restaurants
  return terminal.restaurant_name || relation?.name || 'Unknown restaurant'
}

function isOnline(terminal: Terminal) {
  if (typeof terminal.online === 'boolean') return terminal.online
  const seen = terminal.last_seen_at || terminal.last_seen
  return Boolean(
    terminal.active !== false &&
      terminal.status !== 'revoked' &&
      seen &&
      Date.now() - new Date(seen).getTime() < 15 * 60 * 1000,
  )
}

export default function TerminalsPage() {
  const [terminals, setTerminals] = useState<Terminal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const token = await getAccessToken()
      setLoading(true)
      setError('')
      if (!token) throw new Error('Not signed in')
      const response = await fetch('/api/platform/terminals', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Failed to load terminals')
      setTerminals(Array.isArray(body.terminals) ? body.terminals : [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load terminals')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => load())
  }, [load])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">Terminals</h1>
        <p className="mt-1 text-sm text-[#8A867C]">
          Fleet connectivity, software versions, and device diagnostics.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-[#8A867C]">Loading terminal fleet…</p>
      ) : terminals.length === 0 ? (
        <EmptyState title="No terminals" body="No devices are registered on the platform." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-left text-sm">
              <thead className="border-b border-[#E8E6E1] bg-[#FAFAF8] text-[11px] uppercase tracking-wide text-[#8A867C]">
                <tr>
                  <th className="px-4 py-3 font-semibold">Restaurant</th>
                  <th className="px-4 py-3 font-semibold">Terminal</th>
                  <th className="px-4 py-3 font-semibold">Serial number</th>
                  <th className="px-4 py-3 font-semibold">App version</th>
                  <th className="px-4 py-3 font-semibold">Last seen</th>
                  <th className="px-4 py-3 font-semibold">Health</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EFEDE8]">
                {terminals.map((terminal) => {
                  const seen = terminal.last_seen_at || terminal.last_seen
                  return (
                    <tr key={terminal.id} className="hover:bg-[#FAFAF8]">
                      <td className="px-4 py-3 font-medium text-[#1A1A1A]">
                        {terminal.restaurant_id ? (
                          <Link
                            href={`/admin/restaurants/${terminal.restaurant_id}?tab=terminals`}
                            className="hover:underline"
                          >
                            {relatedName(terminal)}
                          </Link>
                        ) : (
                          relatedName(terminal)
                        )}
                      </td>
                      <td className="px-4 py-3 text-[#5C574E]">
                        {terminal.terminal_name || terminal.name || 'Unnamed'}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-[#5C574E]">
                        {terminal.sn || terminal.device_serial || '—'}
                      </td>
                      <td className="px-4 py-3 text-[#5C574E]">{terminal.app_version || '—'}</td>
                      <td className="px-4 py-3 text-[#8A867C]">
                        {seen ? new Date(seen).toLocaleString() : 'Never'}
                      </td>
                      <td className="px-4 py-3">
                        <HealthBadge status={isOnline(terminal) ? 'online' : 'offline'} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/admin/terminals/${terminal.id}`}
                          className="font-medium text-[#C0392B] hover:underline"
                        >
                          Details
                        </Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
