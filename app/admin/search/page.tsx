'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/platform/ops-shell'
import { getAccessToken } from '@/lib/onboarding/api-client'

type SearchResult = {
  id: string
  title?: string
  label?: string
  name?: string
  subtitle?: string
  detail?: string
  href?: string
  restaurant_id?: string
  order_number?: string
  terminal_name?: string
  description?: string
  status?: string
  payment_status?: string
  restaurants?: { name?: string } | Array<{ name?: string }> | null
}

type ResultGroups = Record<string, SearchResult[]>

const LABELS: Record<string, string> = {
  restaurants: 'Restaurants',
  orders: 'Orders',
  payments: 'Payments',
  terminals: 'Terminals',
  users: 'Users',
  bugReports: 'Bug reports',
  bugs: 'Bug reports',
}

function fallbackHref(group: string, item: SearchResult) {
  if (item.href?.startsWith('/')) return item.href
  if (group === 'restaurants') return `/admin/restaurants/${item.id}`
  if (group === 'terminals') return `/admin/terminals/${item.id}`
  if (group === 'orders' || group === 'payments') {
    return `/admin/payments/lookup?q=${encodeURIComponent(item.order_number || item.id)}`
  }
  if (group === 'bugs' || group === 'bugReports') return `/admin/bug-reports?id=${item.id}`
  if (item.restaurant_id) return `/admin/restaurants/${item.restaurant_id}`
  return '/admin/search'
}

function secondaryText(item: SearchResult) {
  if (item.subtitle || item.detail) return item.subtitle || item.detail
  const relation = Array.isArray(item.restaurants) ? item.restaurants[0] : item.restaurants
  return relation?.name || item.payment_status || item.status || ''
}

export default function AdminSearchPage() {
  const [query, setQuery] = useState('')
  const [searched, setSearched] = useState('')
  const [groups, setGroups] = useState<ResultGroups>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const search = useCallback(async (raw: string) => {
    const q = raw.trim()
    if (!q) return
    try {
      const token = await getAccessToken()
      setLoading(true)
      setError('')
      setSearched(q)
      if (!token) throw new Error('Not signed in')
      const response = await fetch(`/api/platform/search?q=${encodeURIComponent(q)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || 'Search failed')
      const source =
        body.groups && typeof body.groups === 'object'
          ? body.groups
          : body.results && !Array.isArray(body.results) && typeof body.results === 'object'
            ? body.results
            : body
      const next: ResultGroups = {}
      Object.entries(source as Record<string, unknown>).forEach(([key, value]) => {
        if (Array.isArray(value)) next[key] = value as SearchResult[]
      })
      setGroups(next)
    } catch (cause) {
      setGroups({})
      setError(cause instanceof Error ? cause.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void Promise.resolve().then(() => {
      const initial = new URLSearchParams(window.location.search).get('q') || ''
      setQuery(initial)
      if (initial) void search(initial)
    })
  }, [search])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const q = query.trim()
    if (!q) return
    window.history.replaceState(null, '', `/admin/search?q=${encodeURIComponent(q)}`)
    void search(q)
  }

  const entries = Object.entries(groups).filter(([, values]) => values.length > 0)
  const count = entries.reduce((sum, [, values]) => sum + values.length, 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-[#1A1A1A]">Search</h1>
        <p className="mt-1 text-sm text-[#8A867C]">
          Search restaurants, payments, terminals, users, and operational records.
        </p>
      </div>

      <form
        onSubmit={submit}
        className="flex gap-2 rounded-xl border border-[#E8E6E1] bg-white p-4"
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Name, email, FT…, UUID, serial number…"
          className="border-[#E8E6E1]"
          autoFocus
        />
        <Button
          type="submit"
          disabled={loading || !query.trim()}
          className="bg-[#C0392B] text-white hover:bg-[#A93226]"
        >
          {loading ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      ) : null}

      {!loading && searched && count === 0 && !error ? (
        <EmptyState
          title="No results"
          body={`No platform records matched “${searched}”. Try a broader query.`}
        />
      ) : null}

      {entries.map(([group, results]) => (
        <section key={group} className="overflow-hidden rounded-xl border border-[#E8E6E1] bg-white">
          <div className="flex items-center justify-between border-b border-[#E8E6E1] px-4 py-3">
            <h2 className="text-sm font-semibold text-[#1A1A1A]">
              {LABELS[group] || group.replace(/_/g, ' ')}
            </h2>
            <span className="text-xs text-[#8A867C]">{results.length}</span>
          </div>
          <ul className="divide-y divide-[#EFEDE8]">
            {results.map((result) => (
              <li key={result.id}>
                <Link
                  href={fallbackHref(group, result)}
                  className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-[#FAFAF8]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[#1A1A1A]">
                      {result.title ||
                        result.label ||
                        result.name ||
                        result.terminal_name ||
                        result.order_number ||
                        result.description ||
                        result.id}
                    </div>
                    {secondaryText(result) ? (
                      <div className="mt-0.5 truncate text-xs text-[#8A867C]">
                        {secondaryText(result)}
                      </div>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-sm text-[#C0392B]">Open →</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
