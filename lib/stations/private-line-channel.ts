/**
 * lib/stations/private-line-channel.ts — the board-side wiring for the Phase B private channel.
 *
 * ============================================================================================
 * THIS IS A PROBE, NOT YET A FEED
 * ============================================================================================
 *
 * The private channel cannot work until Supabase is registered to trust
 * https://flashtap.app/.well-known/jwks.json, and even after registration the docs say to allow up
 * to 30 minutes for a signing-key change to be picked up. Until then a terminal-JWT is not
 * verifiable there, `auth.jwt()` is null, the SELECT policy in
 * 20260903060000_realtime_private_lines_channel.sql cannot match, and every join here is denied.
 *
 * So this subscribes and REPORTS, and does nothing else that anyone can see. Specifically it does
 * NOT call registerFeedChannel. That omission is the whole design, not an oversight:
 *
 *   The connection indicator takes the WORST status of every registered feed channel. Registering
 *   a channel that is expected to fail for the next several days would put every kitchen and bar
 *   board in the estate into a permanent "degraded" state, over a path carrying no traffic — and
 *   would rebuild, in reverse, the exact defect that made this indicator worth fixing: an
 *   indicator that does not describe what the screen is actually receiving. A board whose real
 *   feeds are healthy must read healthy.
 *
 * It also calls `refetch` on a message. If the private path starts working, the board gets faster
 * immediately; nothing waits on a follow-up deploy. Duplicate invalidations from both channels
 * are harmless — `refetch` is idempotent and the boards already coalesce.
 *
 * ============================================================================================
 * WHAT THIS IS FOR: TELLING "WORKING" FROM "SILENTLY DENIED"
 * ============================================================================================
 *
 * A denied Realtime subscription does not error. It reports SUBSCRIBED and delivers nothing,
 * forever. That single fact has cost this codebase two long investigations — the boards'
 * postgres_changes feed and the terminal's, both documented at length in realtime-invalidate.ts —
 * and it is why the private path cannot be declared working on the strength of a status string.
 *
 * The observable that actually distinguishes the two is: did a message ARRIVE on the private
 * channel within a window where one is known to have been sent on the public one? The public
 * channel is the positive control. Both are recorded here so the comparison can be made from a
 * real board rather than inferred.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { subscribeLineChangedPrivate } from './realtime-invalidate'

/**
 * A SEPARATE client, deliberately. `realtime.setAuth()` applies to a whole connection, and the
 * shared browser client (lib/supabase/client.ts) also carries the boards' postgres_changes
 * subscription — which is dead for a terminal-JWT identity but alive and deliberately retained for
 * a board opened by a member of staff signed in to Supabase Auth. Setting the terminal-JWT on that
 * socket would take the working feed away from precisely the users it works for.
 *
 * No session persistence and no auto-refresh: this client never signs in, holds no GoTrue session,
 * and must not touch the storage the real one uses.
 */
export function createPrivateChannelClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim(),
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  )
}

export type PrivateChannelObservation = {
  /** The literal status string Realtime reported. SUBSCRIBED alone proves nothing — see above. */
  lastStatus: string | null
  /** ISO timestamp of a message actually RECEIVED here. This is the observable that matters. */
  lastMessageAt: string | null
  messageCount: number
}

let observation: PrivateChannelObservation = {
  lastStatus: null,
  lastMessageAt: null,
  messageCount: 0,
}

export function getPrivateChannelObservation(): PrivateChannelObservation {
  return observation
}

/** Test seam; also called when a board unmounts so a remount does not inherit a stale reading. */
export function resetPrivateChannelObservation(): void {
  observation = { lastStatus: null, lastMessageAt: null, messageCount: 0 }
}

/**
 * Starts the probe. Returns its teardown.
 *
 * `onLineChanged` is the board's own refetch. Passing it means the private path delivers real
 * value the moment it starts working, with no further deploy.
 */
export function startPrivateLineChannelProbe(args: {
  restaurantId: string
  terminalToken: string
  station: 'kitchen' | 'bar'
  onLineChanged: () => void
}): () => void {
  try {
    return startProbe(args)
  } catch (error) {
    /**
     * A PROBE MUST NEVER BE ABLE TO TAKE DOWN A BOARD.
     *
     * Not defensive decoration — this is the fix for a regression this very change caused. The
     * probe starts inside app/kitchen/page.tsx's mount effect, so anything it throws propagates out
     * of the mount and the WHOLE BOARD fails to render. Four suites went red at once with
     * `subscribeLineChangedPrivate is not a function`, and the production equivalent of that is a
     * wall screen showing nothing because a DIAGNOSTIC could not start. The board's real feeds —
     * postgres_changes, the public broadcast, the fallback poll — are registered independently and
     * are entirely unaffected by this returning a no-op.
     */
    console.error('[private-line-channel] probe could not start; the board is unaffected', {
      station: args.station,
      restaurantId: args.restaurantId,
      error,
    })
    return () => {}
  }
}

function startProbe(args: {
  restaurantId: string
  terminalToken: string
  station: 'kitchen' | 'bar'
  onLineChanged: () => void
}): () => void {
  const { restaurantId, terminalToken, station, onLineChanged } = args

  const stop = subscribeLineChangedPrivate(
    createPrivateChannelClient,
    restaurantId,
    terminalToken,
    {
      onLineChanged: () => {
        observation = {
          ...observation,
          lastMessageAt: new Date().toISOString(),
          messageCount: observation.messageCount + 1,
        }
        // Logged because this is the line that proves Phase B works. A status of SUBSCRIBED does
        // not; an arrival does.
        console.log('[private-line-channel] MESSAGE RECEIVED — the private path is delivering', {
          station,
          restaurantId,
          count: observation.messageCount,
        })
        onLineChanged()
      },
      onStatus: (status) => {
        observation = { ...observation, lastStatus: status }
        console.log('[private-line-channel] status', { station, restaurantId, status })
      },
    },
  )

  return () => {
    stop()
    resetPrivateChannelObservation()
  }
}
