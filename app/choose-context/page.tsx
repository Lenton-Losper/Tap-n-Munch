'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

type ContextOption =
  | { type: 'platform'; role: string }
  | { type: 'restaurant'; restaurantId: string; role: string; restaurantName: string }

/**
 * Minimal "which account are you signing in as" picker for accounts with
 * more than one context and no valid stored preference (rule 4 of
 * resolveLoginDestination). Not the full Phase 2 context switcher -- just
 * enough to avoid guessing, per the Part 3 scope. Selecting a context writes
 * it to user_active_context via /api/auth/select-context, so this only
 * needs to happen once until the user has a reason to switch.
 */
export default function ChooseContextPage() {
  const router = useRouter()
  const [contexts, setContexts] = useState<ContextOption[] | null>(null)
  const [error, setError] = useState('')
  const [selecting, setSelecting] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken) {
        if (!cancelled) router.replace('/signin?redirect=/choose-context')
        return
      }

      try {
        const response = await fetch('/api/auth/contexts', {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        const payload = await response.json().catch(() => null)
        if (cancelled) return
        if (!response.ok) {
          setError(payload?.error || 'Failed to load your accounts.')
          return
        }
        const list: ContextOption[] = payload?.contexts ?? []
        if (list.length === 1) {
          // Contexts can change between resolveLoginDestination() picking 'picker'
          // and this page loading (e.g. access revoked in another tab) -- if only
          // one is left, skip the picker entirely rather than show a redundant choice.
          void selectContext(list[0], accessToken)
          return
        }
        setContexts(list)
      } catch {
        if (!cancelled) setError('Failed to load your accounts.')
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function selectContext(context: ContextOption, accessTokenOverride?: string) {
    const key = context.type === 'platform' ? 'platform' : context.restaurantId
    setSelecting(key)
    setError('')
    try {
      const accessToken =
        accessTokenOverride ?? (await supabase.auth.getSession()).data.session?.access_token
      if (!accessToken) {
        router.replace('/signin?redirect=/choose-context')
        return
      }

      const response = await fetch('/api/auth/select-context', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(
          context.type === 'platform'
            ? { type: 'platform' }
            : { type: 'restaurant', restaurantId: context.restaurantId },
        ),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.destination) {
        setError(payload?.error || 'Failed to continue. Please try again.')
        setSelecting(null)
        return
      }
      router.replace(payload.destination)
    } catch {
      setError('Failed to continue. Please try again.')
      setSelecting(null)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#F7F6F3] px-4 text-[#37352F]">
      <div className="w-full max-w-md rounded-2xl border border-[#E9E9E7] bg-white p-8 shadow-[0_10px_35px_rgba(55,53,47,0.05)]">
        <h1 className="font-serif text-2xl font-semibold">Choose where to continue</h1>

        {error ? (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        {!contexts ? (
          <p className="mt-6 text-sm text-[#6B675F]">Loading your accounts...</p>
        ) : (
          <div className="mt-6 space-y-2">
            {contexts.map((context) => {
              const key = context.type === 'platform' ? 'platform' : context.restaurantId
              const label = context.type === 'platform' ? 'FlashTap Platform' : context.restaurantName
              return (
                <Button
                  key={key}
                  type="button"
                  variant="outline"
                  disabled={selecting !== null}
                  onClick={() => selectContext(context)}
                  className="h-auto w-full justify-start rounded-lg border-[#E9E9E7] px-4 py-3 text-left text-[15px] font-medium hover:bg-[#F7F6F3]"
                >
                  {selecting === key ? 'Continuing...' : label}
                </Button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
