'use client'

import { forwardRef, useImperativeHandle, useState } from 'react'
import { Button } from '@/components/ui/button'
import { onboardingFetch } from '@/lib/onboarding/api-client'
import type { StepHandle } from './types'

type StepTerminalProps = {
  onError: (message: string) => void
  setSaving: (saving: boolean) => void
}

export const StepTerminal = forwardRef<StepHandle, StepTerminalProps>(function StepTerminal(
  { onError, setSaving },
  ref
) {
  const [code, setCode] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)

  const handleGenerate = async () => {
    setGenerating(true)
    onError('')

    try {
      const payload = await onboardingFetch('/api/admin/terminals/generate-code', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setCode(payload.code)
      setExpiresAt(payload.expiresAt)

      try {
        await onboardingFetch('/api/admin/setup-status', {
          method: 'PATCH',
          body: JSON.stringify({ flag: 'terminal_connected' }),
        })
      } catch {
        // non-blocking
      }
    } catch (error: unknown) {
      onError(error instanceof Error ? error.message : 'Failed to generate activation code')
    } finally {
      setGenerating(false)
    }
  }

  useImperativeHandle(ref, () => ({
    save: async () => {
      setSaving(false)
      return true
    },
  }))

  return (
    <div className="space-y-6">
      <p className="text-sm text-[#6B675F]">
        A FlashTap terminal is the POS device your staff uses to accept payments at the table.
        Generate a one-time activation code to link your terminal app to this restaurant.
      </p>

      <Button
        type="button"
        onClick={handleGenerate}
        disabled={generating}
        className="rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]"
      >
        {generating ? 'Generating...' : 'Generate Activation Code'}
      </Button>

      {code ? (
        <div className="rounded-lg border border-[#E9E9E7] bg-[#FAFAF8] p-6 text-center">
          <p className="text-sm text-[#6B675F]">Your activation code</p>
          <p className="mt-2 font-mono text-3xl font-semibold tracking-wider text-[#37352F]">
            {code}
          </p>
          {expiresAt ? (
            <p className="mt-2 text-xs text-[#9B978E]">
              Expires {new Date(expiresAt).toLocaleString()}
            </p>
          ) : null}
          <p className="mt-4 text-sm text-[#6B675F]">
            Enter this code in your FlashTap POS app to connect your terminal.
          </p>
        </div>
      ) : null}
    </div>
  )
})
