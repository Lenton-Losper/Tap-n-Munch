'use client'

/**
 * feat/station-screens-v1 — AUTH, TEMPORARY, RULED.
 *
 * RULING (this branch's brief, Q3): station credentials are ruled but not built, and are
 * explicitly NOT tomorrow's blocker. For tonight a kitchen/bar wall screen authenticates with
 * the SAME one-hour terminal JWT the physical payment terminal uses
 * (app/api/terminals/activate, app/api/terminal/refresh, lib/terminal-auth.ts's
 * requireTerminalAuth) — reused wholesale, not a new login surface.
 *
 * THIS IS KNOWN TO BE WRONG FOR A WALL SCREEN, ON THE RECORD. An hour-long access token that
 * silently expires is a reasonable risk on a device one person is holding and can re-tap; it is
 * a worse fit for a screen nobody is watching for an auth failure. The ruling accepts that
 * mismatch for tonight rather than build a second credential system under time pressure. The
 * mitigation this file DOES include — refresh() below, called reactively whenever a station API
 * call 401s — is what keeps a shift from silently going dark at the one-hour mark; it does not
 * make the underlying credential model correct for a fixed screen, only survivable for one
 * night. A real "station credential" (long-lived, scoped to a screen rather than a person, no
 * activation-code re-entry) is the follow-up this comment exists to point at.
 *
 * TERMINAL_JWT_PERMISSIONS (lib/terminals/terminal-jwt.ts) does not include an order_lines
 * scope yet — orders:read / orders:update are reused as-is for tonight, since order_lines are
 * sub-records of orders. A dedicated station permission is the same deferral as the credential
 * itself.
 */
import { useCallback, useEffect, useState } from 'react'
import type { StationKind } from '@/lib/stations/station-pairing'

/**
 * ONE KEY PER STATION, NOT ONE PER ORIGIN.
 *
 * ============================================================================================
 * THE DEFECT THIS REPLACES
 * ============================================================================================
 *
 * This was a single constant, `flashtap.station.terminal-session.v1`, shared by every station page
 * on the origin. /kitchen and /bar read and wrote the SAME localStorage entry, so pairing the bar
 * overwrote the kitchen's token and both boards then used whichever was paired last.
 *
 * Two consequences, both seen in the wild on 2026-09-02:
 *   - two boards could not be paired in one browser profile at all, which is why an operator had
 *     to resort to an incognito window;
 *   - a tab opened at /kitchen could be carrying a token paired as something else entirely, at a
 *     different venue, and the board would render it perfectly correctly.
 *
 * THE SERVER WAS NEVER THE PROBLEM. `restaurant_terminals` rows are per terminal, each with its own
 * `station_kind`, and activation updates only the row whose code was redeemed — it has never
 * revoked or displaced a sibling. Two screens were always pairable; the client simply could not
 * hold two tokens.
 *
 * Nothing about how a token is ISSUED changes here. This is only where it is kept.
 */
const STORAGE_KEY_PREFIX = 'flashtap.station.terminal-session.v1'

/**
 * The pre-fix key. Read once, adopted by the first station page that finds it, then removed.
 *
 * Without this every screen already paired in the field would silently need re-activation the
 * moment this deploys — including screens about to be installed on a wall tonight. Adoption is
 * first-come: if the device was paired as bar and someone opens /kitchen first, the kitchen page
 * adopts it, the server refuses it with STATION_NOT_PAIRED, and the operator sees the pairing
 * message that already exists for exactly that case. No authority is granted by the migration;
 * the server still decides.
 */
const LEGACY_STORAGE_KEY = STORAGE_KEY_PREFIX

function storageKeyFor(station: StationKind): string {
  return `${STORAGE_KEY_PREFIX}:${station}`
}

export type TerminalSession = {
  accessToken: string
  refreshToken: string
  restaurantId: string
  terminalId: string
  restaurantName: string
}

function parseSession(raw: string | null): TerminalSession | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<TerminalSession>
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.restaurantId || !parsed.terminalId) {
      return null
    }
    return parsed as TerminalSession
  } catch {
    return null
  }
}

export function readStoredSession(station: StationKind): TerminalSession | null {
  try {
    const own = parseSession(window.localStorage.getItem(storageKeyFor(station)))
    if (own) return own

    // One-time adoption of a pre-fix session. See LEGACY_STORAGE_KEY.
    const legacy = parseSession(window.localStorage.getItem(LEGACY_STORAGE_KEY))
    if (!legacy) return null
    window.localStorage.setItem(storageKeyFor(station), JSON.stringify(legacy))
    window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    return legacy
  } catch {
    return null
  }
}

export function writeStoredSession(station: StationKind, session: TerminalSession | null) {
  try {
    if (session) {
      window.localStorage.setItem(storageKeyFor(station), JSON.stringify(session))
    } else {
      window.localStorage.removeItem(storageKeyFor(station))
    }
  } catch {
    // Best-effort. A private window or a full localStorage means re-activation next load, not a crash.
  }
}

export function useTerminalSession(station: StationKind) {
  const [session, setSession] = useState<TerminalSession | null>(null)
  const [loaded, setLoaded] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect -- one-time read of persisted session on mount */
  useEffect(() => {
    setSession(readStoredSession(station))
    setLoaded(true)
  }, [station])
  /* eslint-enable react-hooks/set-state-in-effect */

  const activate = useCallback(async (code: string) => {
    const response = await fetch('/api/terminals/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    const body = await response.json().catch(() => ({}))

    if (!response.ok) {
      return { error: String(body?.error || 'Invalid or expired activation code.') }
    }

    const next: TerminalSession = {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      restaurantId: body.restaurant_id,
      terminalId: body.terminal_id,
      restaurantName: body.restaurant_name || '',
    }
    writeStoredSession(station, next)
    setSession(next)
    return { error: null }
  }, [station])

  /** Called by a caller that got a 401 from a station API route — rotates both tokens. */
  const refresh = useCallback(async () => {
    if (!session) return null

    const response = await fetch('/api/terminal/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    })

    if (!response.ok) {
      writeStoredSession(station, null)
      setSession(null)
      return null
    }

    const body = await response.json()
    const next: TerminalSession = {
      ...session,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
    }
    writeStoredSession(station, next)
    setSession(next)
    return next
  }, [session, station])

  /**
   * `station` IS A DEPENDENCY of all three callbacks that write the stored session.
   *
   * Each calls writeStoredSession(station, ...), which keys localStorage BY STATION. Omitting it
   * meant a callback captured on one station could persist a session under the other's key. It has
   * never happened, because every caller mounts this hook with a literal ('kitchen' or 'bar') that
   * cannot change for the life of the component -- which is exactly why it went unnoticed rather
   * than why it was safe. Adding it costs nothing at runtime and removes the trap for whoever
   * makes station dynamic.
   */
  const signOut = useCallback(() => {
    writeStoredSession(station, null)
    setSession(null)
  }, [station])

  /**
   * Attaches the current access token and retries ONCE, through refresh(), on a 401 — the
   * mitigation the docblock above describes for an hour-long token on a screen nobody is
   * watching. Every station API call goes through this rather than a bare fetch, so a token
   * that expires mid-shift is invisible to whoever is standing at the pass.
   */
  const authFetch = useCallback(
    async (input: string, init: RequestInit = {}) => {
      const withToken = (token: string): RequestInit => ({
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
      })

      if (!session) throw new Error('No terminal session')

      const first = await fetch(input, withToken(session.accessToken))
      if (first.status !== 401) return first

      const refreshed = await refresh()
      if (!refreshed) return first

      return fetch(input, withToken(refreshed.accessToken))
    },
    [session, refresh],
  )

  return { session, loaded, activate, refresh, signOut, authFetch }
}

export type AuthFetch = ReturnType<typeof useTerminalSession>['authFetch']
