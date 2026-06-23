'use client'

import { ProtectedRoute } from '@/components/auth/protected-route'
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard'

export default function OnboardingPage() {
  return (
    <ProtectedRoute>
      <OnboardingWizard />
    </ProtectedRoute>
  )
}
