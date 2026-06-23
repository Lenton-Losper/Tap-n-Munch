'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useAuth } from '@/components/auth/auth-provider'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  getFirstIncompleteWizardStep,
  WIZARD_STEPS,
  type SetupStatus,
} from '@/lib/onboarding/setup-status'
import { onboardingFetch } from '@/lib/onboarding/api-client'
import { StepProfile } from './step-profile'
import { StepTables } from './step-tables'
import { StepMenu } from './step-menu'
import { StepQrCodes } from './step-qr-codes'
import { StepStaff } from './step-staff'
import { StepTerminal } from './step-terminal'
import { StepTestOrder } from './step-test-order'
import type { StepHandle } from './types'

const TOTAL_STEPS = WIZARD_STEPS.length

export function OnboardingWizard() {
  const router = useRouter()
  const { restaurant, restaurantId, loading: authLoading } = useAuth()
  const [currentStep, setCurrentStep] = useState(1)
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [testOrderDone, setTestOrderDone] = useState(false)

  const stepRef = useRef<StepHandle | null>(null)

  const refreshStatus = useCallback(async () => {
    const payload = await onboardingFetch('/api/admin/setup-status')
    setSetupStatus(payload as SetupStatus)
    return payload as SetupStatus
  }, [])

  useEffect(() => {
    if (authLoading || !restaurantId) return

    let cancelled = false
    ;(async () => {
      try {
        const status = await refreshStatus()
        if (!cancelled) {
          setCurrentStep(getFirstIncompleteWizardStep(status))
          setTestOrderDone(Boolean(status.test_order_completed))
        }
      } catch (loadError: unknown) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : 'Failed to load setup progress'
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [authLoading, restaurantId, refreshStatus])

  const stepMeta = WIZARD_STEPS[currentStep - 1]
  const progressValue = (currentStep / TOTAL_STEPS) * 100
  const skippable = currentStep === 5 || currentStep === 6

  const handleBack = () => {
    setError('')
    setCurrentStep((prev) => Math.max(1, prev - 1))
  }

  const handleSkip = () => {
    setError('')
    setCurrentStep((prev) => Math.min(TOTAL_STEPS, prev + 1))
  }

  const handleNext = async () => {
    setError('')

    if (currentStep === 7 && testOrderDone) {
      router.push('/dashboard')
      return
    }

    const stepHandle = stepRef.current
    if (stepHandle) {
      const ok = await stepHandle.save()
      if (!ok) return
    }

    try {
      await refreshStatus()
    } catch {
      // non-blocking
    }

    if (currentStep < TOTAL_STEPS) {
      setCurrentStep((prev) => prev + 1)
    }
  }

  if (authLoading || loading || !restaurantId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F7F6F3] text-[#6B675F]">
        Loading setup wizard...
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#F7F6F3] px-4 py-10 text-[#37352F]">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8">
          <p className="text-sm font-medium text-[#6B675F]">
            Step {currentStep} of {TOTAL_STEPS}
          </p>
          <Progress value={progressValue} className="mt-3 h-2" />
        </div>

        <section className="rounded-2xl border border-[#E9E9E7] bg-white p-8 shadow-[0_10px_35px_rgba(55,53,47,0.05)]">
          <h1 className="font-serif text-3xl font-semibold">{stepMeta.title}</h1>
          <p className="mt-2 text-sm text-[#6B675F]">{stepMeta.subtitle}</p>

          <div className="mt-8">
            {currentStep === 1 ? (
              <StepProfile
                ref={stepRef}
                restaurantId={restaurantId}
                initialName={String(restaurant?.name || '')}
                initialPhone={String(restaurant?.phone || '')}
                initialAddress={String(restaurant?.address || '')}
                initialCurrency={String(restaurant?.currency || 'NAD')}
                initialLogoUrl={restaurant?.logo_url ? String(restaurant.logo_url) : null}
                onError={setError}
                setSaving={setSaving}
              />
            ) : null}

            {currentStep === 2 ? (
              <StepTables
                ref={stepRef}
                restaurantId={restaurantId}
                onError={setError}
                setSaving={setSaving}
              />
            ) : null}

            {currentStep === 3 ? (
              <StepMenu
                ref={stepRef}
                restaurantId={restaurantId}
                onError={setError}
                setSaving={setSaving}
              />
            ) : null}

            {currentStep === 4 ? (
              <StepQrCodes
                ref={stepRef}
                restaurantId={restaurantId}
                onError={setError}
                setSaving={setSaving}
              />
            ) : null}

            {currentStep === 5 ? (
              <StepStaff ref={stepRef} onError={setError} setSaving={setSaving} />
            ) : null}

            {currentStep === 6 ? (
              <StepTerminal ref={stepRef} onError={setError} setSaving={setSaving} />
            ) : null}

            {currentStep === 7 ? (
              <StepTestOrder
                ref={stepRef}
                restaurantId={restaurantId}
                onError={setError}
                setSaving={setSaving}
                onComplete={() => setTestOrderDone(true)}
              />
            ) : null}
          </div>

          {error ? (
            <p className="mt-6 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          ) : null}

          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-[#E9E9E7] pt-6">
            <Button
              type="button"
              variant="outline"
              onClick={handleBack}
              disabled={currentStep === 1 || saving}
              className="rounded-lg border-[#E9E9E7]"
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Back
            </Button>

            <div className="flex flex-wrap gap-3">
              {skippable ? (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleSkip}
                  disabled={saving}
                  className="text-[#6B675F]"
                >
                  Skip for now
                </Button>
              ) : null}

              <Button
                type="button"
                onClick={handleNext}
                disabled={saving}
                className="rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]"
              >
                {currentStep === 7 && testOrderDone ? (
                  'Go to Dashboard'
                ) : (
                  <>
                    {currentStep === TOTAL_STEPS ? 'Complete' : 'Next'}
                    {currentStep < TOTAL_STEPS ? <ChevronRight className="ml-1 h-4 w-4" /> : null}
                  </>
                )}
              </Button>
            </div>
          </div>
        </section>

        {setupStatus ? (
          <p className="mt-4 text-center text-xs text-[#9B978E]">
            Setup progress saved · {setupStatus.completion_percentage ?? 0}% complete
          </p>
        ) : null}
      </div>
    </div>
  )
}
