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

const STORAGE_KEY = 'flashtap.station.terminal-session.v1'

export type TerminalSession = {
  accessToken: string
  refreshToken: string
  restaurantId: string
  terminalId: string
  restaurantName: string
}

function readStoredSession(): TerminalSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<TerminalSession>
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.restaurantId || !parsed.terminalId) {
      return null
    }
    return parsed as TerminalSession
  } catch {
    return null
  }
}

function writeStoredSession(session: TerminalSession | null) {
  try {
    if (session) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    } else {
      window.localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    // Best-effort. A private window or a full localStorage means re-activation next load, not a crash.
  }
}

export function useTerminalSession() {
  const [session, setSession] = useState<TerminalSession | null>(null)
  const [loaded, setLoaded] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect -- one-time read of persisted session on mount */
  useEffect(() => {
    setSession(readStoredSession())
    setLoaded(true)
  }, [])
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
    writeStoredSession(next)
    setSession(next)
    return { error: null }
  }, [])

  /** Called by a caller that got a 401 from a station API route — rotates both tokens. */
  const refresh = useCallback(async () => {
    if (!session) return null

    const response = await fetch('/api/terminal/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    })

    if (!response.ok) {
      writeStoredSession(null)
      setSession(null)
      return null
    }

    const body = await response.json()
    const next: TerminalSession = {
      ...session,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
    }
    writeStoredSession(next)
    setSession(next)
    return next
  }, [session])

  const signOut = useCallback(() => {
    writeStoredSession(null)
    setSession(null)
  }, [])

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
