import type { Metadata } from 'next'
import { SignInClient } from './signin-client'

export const metadata: Metadata = {
  title: 'Sign In | FlashTap',
  description: 'Sign in to manage your FlashTap venue dashboard.',
}

export default function SignInPage() {
  return <SignInClient />
}

