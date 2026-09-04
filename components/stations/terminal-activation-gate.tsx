'use client'

import { useEffect, useRef, useState } from 'react'
import { STATION_COPY } from '@/lib/stations/copy'
import { useTerminalSession, type AuthFetch, type TerminalSession } from '@/lib/stations/use-terminal-session'
import type { StationKind } from '@/lib/stations/station-pairing'
import { readActivationCode, stripActivationParam } from '@/lib/stations/activation-link'

/**
 * feat/station-screens-v1 — the on-page activation form, shown until a terminal session exists.
 * Wraps children (the actual screen) once activated, mirroring how the physical terminal app
 * gates its own screens behind activation before showing anything order-related. Passes
 * `authFetch` through so every station API call gets the 401-triggers-refresh handling
 * lib/stations/use-terminal-session.ts's docblock describes.
 */
export function TerminalActivationGate({
  children,
  station,
}: {
  children: (session: TerminalSession, authFetch: AuthFetch) => React.ReactNode
  /** Which screen is being paired, so the confirmation can say so in words. #371. */
  station: StationKind
}) {
  // The station this gate is guarding decides WHICH stored session it reads. See
  // lib/stations/use-terminal-session.ts: one key per station, not one per origin.
  const { session, loaded, activate, authFetch } = useTerminalSession(station)

  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  /**
   * #371: TRUE ONLY FOR A PAIRING THAT JUST HAPPENED IN FRONT OF SOMEBODY.
   *
   * Initial state is false, so a screen that reloads with a stored session goes straight to the
   * board as before -- a wall screen rebooting at 6am must not stop on a confirmation nobody is
   * there to dismiss. It is set only by a successful activate() in this session.
   */
  const [justPaired, setJustPaired] = useState(false)
  /**
   * ONE-CLICK PAIRING. A link from the venue's settings carries the SAME activation code someone
   * would otherwise read off a laptop and type in here — see lib/stations/activation-link.ts. The
   * typed form below is untouched and remains the fallback.
   *
   * `autoAttempted` guards against a second submission: React may run this effect again, and a
   * spent code would then produce a spurious "invalid or expired" over a pairing that already
   * worked.
   *
   * A REF, NOT STATE, and it was state until 2026-09-04. Nothing renders this value — it is read
   * only by the effect that sets it — so as state it bought a re-render per pairing and a
   * setState synchronously inside an effect, which is what the react-compiler rule refuses.
   *
   * The ref is also the STRONGER guard. A ref updates synchronously, so the immediate second
   * invocation React performs in StrictMode already sees `true`; a state update is queued, so the
   * second invocation could still read `false` and fire the spent code a second time. Removing the
   * value from the dependency array is safe for the same reason: it was never a reason to re-run.
   */
  const autoAttempted = useRef(false)
  useEffect(() => {
    if (!loaded || session || autoAttempted.current) return
    const code = readActivationCode(window.location.search)
    if (!code) return
    autoAttempted.current = true
    /**
     * STRIPPED BEFORE IT IS SUBMITTED, not after. A failure must not leave a spent or invalid code
     * in the address bar to be reloaded, bookmarked or photographed.
     */
    window.history.replaceState(null, '', `${window.location.pathname}${stripActivationParam(window.location.search)}`)
    void activate(code).then((result) => {
      if (result.error) setError(result.error)
      else setJustPaired(true)
    })
  }, [loaded, session, activate])

  if (!loaded) {
    return null
  }

  if (session && !justPaired) {
    return <>{children(session, authFetch)}</>
  }

  const stationLabel = station === 'kitchen' ? STATION_COPY.kitchen.pageTitle : STATION_COPY.bar.pageTitle

  /**
   * THE CONFIRMATION. The whole point of #371: the activation code carries the venue with it and
   * the person typing it cannot see which one. On 2026-09-02 a screen standing in Riviera was
   * paired to another venue entirely and said nothing about it for 45 minutes.
   */
  if (session && justPaired) {
    const venueName = (session.restaurantName ?? '').trim()
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#FAFAF8] p-6">
        <div
          className="w-full max-w-md rounded-2xl border border-[#E9E9E7] bg-white p-8 text-center"
          data-testid="terminal-paired-confirmation"
          data-venue={venueName || 'unknown'}
        >
          <h1 className="font-serif text-2xl font-semibold text-[#37352F]">
            {STATION_COPY.activation.pairedHeading}
          </h1>
          <p className="mt-3 text-lg text-[#37352F]">
            {venueName
              ? STATION_COPY.activation.pairedTo(venueName, stationLabel)
              : STATION_COPY.activation.pairedToUnknownVenue(stationLabel)}
          </p>
          <p className="mt-3 text-sm text-[#6B675F]">{STATION_COPY.activation.pairedWrongVenueHint}</p>
          <button
            type="button"
            onClick={() => setJustPaired(false)}
            className="mt-6 w-full rounded-lg bg-[#FF6B35] px-3 py-2 font-medium text-white hover:bg-[#e85f2f]"
          >
            {STATION_COPY.activation.startButton}
          </button>
        </div>
      </div>
    )
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    const result = await activate(code.trim())
    setSubmitting(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setJustPaired(true)
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#FAFAF8] p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-[#E9E9E7] bg-white p-6"
        data-testid="terminal-activation-gate"
      >
        <h1 className="font-serif text-xl font-semibold text-[#37352F]">{STATION_COPY.activation.heading}</h1>
        <p className="mt-1 text-sm text-[#6B675F]">{STATION_COPY.activation.instructions}</p>

        {error ? (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <input
          type="text"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={STATION_COPY.activation.codePlaceholder}
          className="mt-4 w-full rounded-lg border border-[#E9E9E7] px-3 py-2 text-lg tracking-widest"
          autoFocus
        />

        <button
          type="submit"
          disabled={submitting || !code.trim()}
          className="mt-4 w-full rounded-lg bg-[#FF6B35] px-3 py-2 font-medium text-white hover:bg-[#e85f2f] disabled:opacity-50"
        >
          {submitting ? STATION_COPY.activation.submittingButton : STATION_COPY.activation.submitButton}
        </button>
      </form>
    </div>
  )
}
