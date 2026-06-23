'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check, Circle } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { Button } from '@/components/ui/button'
import {
  SETUP_CHECKLIST_LABELS,
  type SetupStatus,
} from '@/lib/onboarding/setup-status'
import { onboardingFetch } from '@/lib/onboarding/api-client'

export function SetupChecklistBanner() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const payload = await onboardingFetch('/api/admin/setup-status')
        if (!cancelled) setStatus(payload as SetupStatus)
      } catch {
        if (!cancelled) setStatus(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (loading || !status) return null

  const completion = status.completion_percentage ?? 0
  if (completion >= 100) return null

  return (
    <div className="border-b border-[#E9E9E7] bg-white px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-sm font-semibold text-[#37352F]">FlashTap Setup</h2>
            <span className="text-sm text-[#6B675F]">{completion}% Complete</span>
          </div>
          <Progress value={completion} className="mt-3 h-2 max-w-xl" />

          <ul className="mt-4 grid gap-2 sm:grid-cols-2">
            {SETUP_CHECKLIST_LABELS.map(({ flag, label }) => {
              const done = Boolean(status[flag])
              return (
                <li key={flag} className="flex items-center gap-2 text-sm text-[#37352F]">
                  {done ? (
                    <Check className="h-4 w-4 text-green-600" />
                  ) : (
                    <Circle className="h-4 w-4 text-[#BFBAB0]" />
                  )}
                  <span className={done ? 'text-[#6B675F]' : ''}>{label}</span>
                </li>
              )
            })}
          </ul>
        </div>

        <Button
          asChild
          className="shrink-0 rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]"
        >
          <Link href="/onboarding">Continue Setup →</Link>
        </Button>
      </div>
    </div>
  )
}
