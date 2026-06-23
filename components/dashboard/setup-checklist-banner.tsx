'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  SETUP_CHECKLIST_LABELS,
  type SetupStatus,
} from '@/lib/onboarding/setup-status'
import { onboardingFetch } from '@/lib/onboarding/api-client'

const DISMISS_STORAGE_KEY = 'setup_wizard_dismissed'
const BRAND_ORANGE = '#d96a3b'
const BAR_BG = '#fdf6f0'
const BAR_BORDER = '#e8d5c4'
const TRACK_BG = '#f0ddd0'
const LABEL_COLOR = '#7a5c4a'
const DISMISS_COLOR = '#b0907a'
const HOVER_BG = '#f5e8df'
const INCOMPLETE_TEXT = '#2a1a0e'
const COMPLETE_TEXT = '#999999'
const COMPLETE_GREEN = '#22c55e'

function PercentageBadge({ value }: { value: number }) {
  return (
    <div
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{
        backgroundColor: BRAND_ORANGE,
        fontSize: '11px',
        width: '32px',
        height: '32px',
      }}
      aria-hidden
    >
      {value}%
    </div>
  )
}

export function SetupChecklistBanner() {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setDismissed(sessionStorage.getItem(DISMISS_STORAGE_KEY) === 'true')
    }
  }, [])

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

  const handleDismiss = () => {
    sessionStorage.setItem(DISMISS_STORAGE_KEY, 'true')
    setDismissed(true)
  }

  if (dismissed) return null

  if (loading) {
    return (
      <div
        style={{ backgroundColor: BAR_BG, borderBottom: `1px solid ${BAR_BORDER}`, height: '48px' }}
        className="flex items-center px-4 gap-3 animate-pulse"
      >
        <div className="w-8 h-8 rounded-full shrink-0" style={{ background: TRACK_BG }} />
        <div className="flex-1 h-2 rounded" style={{ background: TRACK_BG }} />
      </div>
    )
  }

  if (!status) return null

  const completion = status.completion_percentage ?? 0
  if (completion >= 100) return null

  return (
    <div
      className="border-b"
      style={{ backgroundColor: BAR_BG, borderBottom: `1px solid ${BAR_BORDER}` }}
    >
      {/* Collapsed slim bar — max 48px */}
      <div className="flex h-12 max-h-12 items-center gap-3 px-4">
        <div className="flex shrink-0 items-center gap-2">
          <PercentageBadge value={completion} />
          <span
            className="whitespace-nowrap"
            style={{ fontSize: '13px', color: LABEL_COLOR }}
          >
            Setup in progress
          </span>
        </div>

        <div
          className="mx-2 min-w-0 flex-1 overflow-hidden"
          style={{
            height: '6px',
            backgroundColor: TRACK_BG,
            borderRadius: '3px',
          }}
          role="progressbar"
          aria-valuenow={completion}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${completion}%`,
              backgroundColor: BRAND_ORANGE,
              borderRadius: '3px',
            }}
          />
        </div>

        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="shrink-0 rounded px-2 py-1 transition-colors"
          style={{
            fontSize: '13px',
            color: BRAND_ORANGE,
            backgroundColor: 'transparent',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = HOVER_BG
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent'
          }}
        >
          {expanded ? '▲ Hide checklist' : '▼ Show checklist'}
        </button>

        <button
          type="button"
          onClick={handleDismiss}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-lg leading-none transition-colors"
          style={{ color: DISMISS_COLOR, backgroundColor: 'transparent' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = BRAND_ORANGE
            e.currentTarget.style.backgroundColor = HOVER_BG
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = DISMISS_COLOR
            e.currentTarget.style.backgroundColor = 'transparent'
          }}
          aria-label="Dismiss setup wizard for this session"
        >
          ×
        </button>
      </div>

      {/* Expanded checklist */}
      {expanded ? (
        <div
          style={{
            borderTop: `1px solid ${TRACK_BG}`,
            padding: '16px 20px',
          }}
        >
          <ul className="grid gap-2 sm:grid-cols-2">
            {SETUP_CHECKLIST_LABELS.map(({ flag, label }) => {
              const done = Boolean(status[flag])
              return (
                <li
                  key={flag}
                  className="text-sm"
                  style={{
                    color: done ? COMPLETE_TEXT : INCOMPLETE_TEXT,
                    fontWeight: done ? 400 : 500,
                  }}
                >
                  <span
                    style={{ color: done ? COMPLETE_GREEN : BRAND_ORANGE }}
                    aria-hidden
                  >
                    {done ? '✓ ' : '→ '}
                  </span>
                  {label}
                </li>
              )
            })}
          </ul>

          <div
            className="mt-4 pt-4"
            style={{ borderTop: '1px solid #eeeeee' }}
          >
            <Link
              href="/onboarding"
              className="inline-block transition-opacity hover:opacity-90"
              style={{
                backgroundColor: '#111111',
                color: '#ffffff',
                padding: '10px 20px',
                borderRadius: '8px',
                fontSize: '13px',
                fontWeight: 600,
              }}
            >
              Continue Setup →
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  )
}
