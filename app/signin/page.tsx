import type { Metadata } from 'next'
import { Suspense } from 'react'
import { SignInClient } from './signin-client'

export const metadata: Metadata = {
  title: 'Sign In | FlashTap',
  description: 'Sign in to manage your FlashTap venue dashboard.',
}

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#F7F6F3] text-[#6B675F]">
          Loading...
        </div>
      }
    >
      <SignInClient />
    </Suspense>
  )
}

