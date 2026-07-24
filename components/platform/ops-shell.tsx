'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Bug,
  Building2,
  CreditCard,
  LayoutDashboard,
  LineChart,
  Search,
  Settings,
  Shield,
  TabletSmartphone,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

const NAV = [
  { href: '/admin/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/alerts', label: 'Alerts', icon: AlertTriangle },
  { href: '/admin/restaurants', label: 'Restaurants', icon: Building2 },
  { href: '/admin/terminals', label: 'Terminals', icon: TabletSmartphone },
  { href: '/admin/payments', label: 'Payments', icon: CreditCard },
  { href: '/admin/search', label: 'Search', icon: Search },
  { href: '/admin/analytics', label: 'Analytics', icon: LineChart },
  { href: '/admin/audit-logs', label: 'Audit logs', icon: Shield },
  { href: '/admin/bug-reports', label: 'Bug reports', icon: Bug },
  { href: '/admin/settings/admins', label: 'Settings', icon: Settings },
] as const

export function OpsShell({
  children,
  alertCount = 0,
}: {
  children: React.ReactNode
  alertCount?: number
}) {
  const pathname = usePathname()
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const activeHref = useMemo(() => {
    const match = NAV.find((n) => pathname === n.href || pathname.startsWith(`${n.href}/`))
    return match?.href ?? ''
  }, [pathname])

  const submitSearch = (e?: React.FormEvent) => {
    e?.preventDefault()
    const q = query.trim()
    if (!q) return
    setSearchOpen(false)
    router.push(`/admin/search?q=${encodeURIComponent(q)}`)
  }

  return (
    <div className="min-h-screen bg-[#F7F7F5] text-[#1A1A1A]">
      <div className="mx-auto flex min-h-screen max-w-[1600px]">
        <aside className="sticky top-0 flex h-screen w-56 shrink-0 flex-col border-r border-[#E8E6E1] bg-[#FAFAF8] px-3 py-5">
          <div className="mb-6 px-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#8A867C]">
              FlashTap
            </div>
            <div className="mt-1 text-sm font-semibold text-[#1A1A1A]">Ops Console</div>
          </div>
          <nav className="flex flex-1 flex-col gap-0.5">
            {NAV.map((item) => {
              const Icon = item.icon
              const active = activeHref === item.href
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors',
                    active
                      ? 'bg-[#1A1A1A] text-white'
                      : 'text-[#5C574E] hover:bg-[#EFEDE8] hover:text-[#1A1A1A]',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0 opacity-80" />
                  <span className="flex-1">{item.label}</span>
                  {item.href === '/admin/alerts' && alertCount > 0 ? (
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                        active ? 'bg-white/20 text-white' : 'bg-[#C0392B] text-white',
                      )}
                    >
                      {alertCount > 99 ? '99+' : alertCount}
                    </span>
                  ) : null}
                </Link>
              )
            })}
          </nav>
          <div className="mt-4 border-t border-[#E8E6E1] px-2 pt-3 text-[11px] text-[#8A867C]">
            Platform admin
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-[#E8E6E1] bg-[#F7F7F5]/95 px-6 backdrop-blur">
            <Activity className="h-4 w-4 text-[#8A867C]" />
            <form onSubmit={submitSearch} className="flex max-w-xl flex-1 items-center gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search restaurants, orders, FT…, terminals (⌘K)"
                className="h-9 border-[#E8E6E1] bg-white text-sm"
                onFocus={() => setSearchOpen(true)}
              />
              <Button type="submit" variant="outline" className="h-9 border-[#E8E6E1]">
                Search
              </Button>
            </form>
          </header>

          {searchOpen ? (
            <div
              className="fixed inset-0 z-30 bg-black/20"
              onClick={() => setSearchOpen(false)}
              aria-hidden
            />
          ) : null}

          <main className="flex-1 px-6 py-6">{children}</main>
        </div>
      </div>
    </div>
  )
}

export function HealthBadge({
  status,
}: {
  status:
    | 'ok'
    | 'operational'
    | 'degraded'
    | 'critical'
    | 'outage'
    | 'unknown'
    | 'offline'
    | 'online'
    | 'healthy'
    | 'watch'
}) {
  const map = {
    ok: { label: 'Healthy', className: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
    healthy: { label: 'Healthy', className: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
    operational: { label: 'Operational', className: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
    online: { label: 'Online', className: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
    watch: { label: 'Watch', className: 'bg-sky-50 text-sky-900 border-sky-200' },
    degraded: { label: 'Degraded', className: 'bg-amber-50 text-amber-900 border-amber-200' },
    critical: { label: 'Critical', className: 'bg-red-50 text-red-800 border-red-200' },
    outage: { label: 'Outage', className: 'bg-red-50 text-red-800 border-red-200' },
    offline: { label: 'Offline', className: 'bg-red-50 text-red-800 border-red-200' },
    unknown: { label: 'Unknown', className: 'bg-stone-100 text-stone-600 border-stone-200' },
  } as const
  const m = map[status]
  return (
    <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold', m.className)}>
      {m.label}
    </span>
  )
}

export function ScoreMeter({ score, band }: { score: number; band: string }) {
  const tone =
    band === 'healthy'
      ? 'bg-emerald-600'
      : band === 'watch'
        ? 'bg-sky-600'
        : band === 'degraded'
          ? 'bg-amber-500'
          : 'bg-red-600'
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-[#EFEDE8]">
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
      </div>
      <span className="tabular-nums text-sm font-semibold text-[#1A1A1A]">{score}</span>
    </div>
  )
}

export function KpiCard({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="rounded-xl border border-[#E8E6E1] bg-white p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[#8A867C]">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-[#1A1A1A]">{value}</div>
      {hint ? <div className="mt-1 text-xs text-[#8A867C]">{hint}</div> : null}
    </div>
  )
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[#E8E6E1] bg-white px-6 py-12 text-center">
      <div className="text-sm font-semibold text-[#1A1A1A]">{title}</div>
      <p className="mx-auto mt-2 max-w-md text-sm text-[#8A867C]">{body}</p>
    </div>
  )
}
