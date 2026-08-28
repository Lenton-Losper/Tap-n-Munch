'use client'

import { useState } from 'react'
import { STATION_COPY } from '@/lib/stations/copy'
import { useTerminalSession, type AuthFetch, type TerminalSession } from '@/lib/stations/use-terminal-session'

/**
 * feat/station-screens-v1 — the on-page activation form, shown until a terminal session exists.
 * Wraps children (the actual screen) once activated, mirroring how the physical terminal app
 * gates its own screens behind activation before showing anything order-related. Passes
 * `authFetch` through so every station API call gets the 401-triggers-refresh handling
 * lib/stations/use-terminal-session.ts's docblock describes.
 */
export function TerminalActivationGate({
  children,
}: {
  children: (session: TerminalSession, authFetch: AuthFetch) => React.ReactNode
}) {
  const { session, loaded, activate, authFetch } = useTerminalSession()
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!loaded) {
    return null
  }

  if (session) {
    return <>{children(session, authFetch)}</>
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    const result = await activate(code.trim())
    setSubmitting(false)
    if (result.error) {
      setError(result.error)
    }
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
