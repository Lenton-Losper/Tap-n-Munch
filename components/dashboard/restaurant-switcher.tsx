'use client'

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/components/auth/auth-provider'
import { useToast } from '@/hooks/use-toast'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  buildRestaurantSwitcher,
  type SwitcherContextInput,
} from '@/lib/auth/restaurant-switcher-options'

/**
 * THE AFFORDANCE #321 LEFT MISSING.
 *
 * #321 made /api/auth/role honour `user_active_context`, so the session follows a stored choice.
 * Nothing in the product could make that choice: app/choose-context writes it, but rule 3 of
 * resolveLoginDestination resolves past the picker for anyone who already has a valid stored
 * context, so it is reachable only by typing the URL. An owner with two locations could see both
 * in Settings and open only one.
 *
 * This renders nothing for a single-restaurant account -- see buildRestaurantSwitcher, where that
 * rule lives as a pure function so it is tested without a DOM.
 *
 * SELECTING DOES NOT SWITCH ANYTHING CLIENT-SIDE. It POSTs to /api/auth/select-context, which
 * re-derives the caller's real contexts from restaurant_users and 403s anything that is not among
 * them, then does a FULL navigation. A soft route change would leave AuthProvider's cached
 * restaurantId (and its localStorage mirror) pointing at the old restaurant, since the provider
 * re-resolves only on load. Persistence across a reload is the whole point of the control.
 */

/**
 * PARTIALLY SIGNED OFF. Placeholders below are placeholders, not drafted copy — do not write final
 * wording here.
 *
 * These five reached PRODUCTION as markers and the restaurant owner read one of them on every staff
 * screen. The convention worked; the enforcement did not. `scripts/check-no-pending-copy.mjs` now
 * fails the production deploy while any of them remains, so this block cannot ship half-done again.
 *
 * The const keeps its `_PENDING` name until the last one is signed, because renaming it while four
 * are outstanding would say the block is done when it is not.
 */
const SWITCHER_COPY_PENDING = {
  /** SIGNED OFF 2026-08-21. */
  label: 'Location',
  placeholder: 'PENDING COPY — Choose a location',
  switching: 'PENDING COPY — Switching…',
  failedTitle: 'PENDING COPY — Could not switch location',
  failedBody: 'PENDING COPY — Your location was not changed. Try again.',
} as const

export function RestaurantSwitcher() {
  const { restaurantId } = useAuth()
  const { toast } = useToast()
  const [contexts, setContexts] = useState<SwitcherContextInput[] | null>(null)
  const [switching, setSwitching] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase.auth.getSession()
      const accessToken = data.session?.access_token
      if (!accessToken) return

      try {
        const response = await fetch('/api/auth/contexts', {
          headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (!response.ok) return
        const payload = await response.json().catch(() => null)
        if (cancelled) return
        setContexts(payload?.contexts ?? [])
      } catch {
        // A failed lookup means no switcher, never a broken sidebar -- the rest of the nav is
        // unaffected and the user keeps working on their current restaurant.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const model = buildRestaurantSwitcher({ contexts, currentRestaurantId: restaurantId })

  const handleSelect = useCallback(
    async (nextRestaurantId: string) => {
      if (!nextRestaurantId || nextRestaurantId === restaurantId || switching) return

      setSwitching(true)
      try {
        const { data } = await supabase.auth.getSession()
        const accessToken = data.session?.access_token
        if (!accessToken) {
          window.location.assign('/signin')
          return
        }

        const response = await fetch('/api/auth/select-context', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ type: 'restaurant', restaurantId: nextRestaurantId }),
        })
        const payload = await response.json().catch(() => null)

        if (!response.ok || !payload?.destination) {
          // Never a silent no-op: a refused or failed switch says so, and the sidebar keeps
          // showing the restaurant the session is actually on.
          toast({
            title: SWITCHER_COPY_PENDING.failedTitle,
            description: payload?.error || SWITCHER_COPY_PENDING.failedBody,
            variant: 'destructive',
          })
          setSwitching(false)
          return
        }

        window.location.assign(payload.destination)
      } catch (error: unknown) {
        toast({
          title: SWITCHER_COPY_PENDING.failedTitle,
          description: error instanceof Error ? error.message : SWITCHER_COPY_PENDING.failedBody,
          variant: 'destructive',
        })
        setSwitching(false)
      }
    },
    [restaurantId, switching, toast],
  )

  if (!model.visible) return null

  return (
    <div className="mt-2">
      <label
        htmlFor="restaurant-switcher"
        className="text-[10px] font-medium uppercase tracking-wide text-[#6B675F]"
      >
        {SWITCHER_COPY_PENDING.label}
      </label>
      <Select
        value={restaurantId ?? undefined}
        onValueChange={handleSelect}
        disabled={switching}
      >
        <SelectTrigger
          id="restaurant-switcher"
          className="mt-1 h-8 w-full border-[#E9E9E7] bg-[#FAFAF8] px-2 text-xs text-[#37352F]"
        >
          <SelectValue placeholder={SWITCHER_COPY_PENDING.placeholder} />
        </SelectTrigger>
        <SelectContent>
          {model.options.map((option) => (
            <SelectItem key={option.restaurantId} value={option.restaurantId} className="text-xs">
              {option.restaurantName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {switching ? (
        <p className="mt-1 text-[10px] text-[#6B675F]">{SWITCHER_COPY_PENDING.switching}</p>
      ) : null}
    </div>
  )
}
