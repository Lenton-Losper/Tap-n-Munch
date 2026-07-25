'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'
import { SupabaseConfigError } from '@/components/auth/supabase-config-error'
import { AuthDivider, GoogleSignInButton } from '@/components/auth/google-sign-in-button'
import { useAuth } from '@/components/auth/auth-provider'
import { signInWithGoogleOAuth } from '@/lib/supabase/google-auth'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const GOOGLE_SIGNIN_HINT =
  "It looks like you signed up with Google. Please use the 'Continue with Google' button to sign in."

function isInvalidCredentialsError(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('invalid login credentials') ||
    normalized.includes('invalid credentials') ||
    normalized.includes('invalid email or password')
  )
}

/**
 * Only show the Google hint when the account is confirmed Google-only —
 * never on a generic invalid-credentials error alone (#34). Fails closed
 * (no hint) on any lookup error.
 */
async function shouldShowGoogleHint(email: string): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/signin-hint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    if (!response.ok) return false
    const payload = await response.json()
    return payload?.showGoogleHint === true
  } catch {
    return false
  }
}

export function SignInClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, loading: authLoading, isSupabaseConfigured, signIn, roleResolved } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [error, setError] = useState('')
  const oauthProfileError =
    searchParams.get('error') === 'oauth_profile'
      ? "We couldn't finish setting up your account. Please contact support."
      : ''
  const oauthError =
    searchParams.get('error') === 'oauth' ? 'Google sign-in failed. Please try again.' : ''
  const displayError = error || oauthProfileError || oauthError
  const resetSuccessMessage =
    searchParams.get('reset') === 'success'
      ? 'Your password has been updated. Sign in with your new password.'
      : ''

  useEffect(() => {
    // authLoading can briefly go false (set by the Supabase auth-event listener itself)
    // before loadUserData has actually resolved restaurantId/isPlatformAdmin -- wait for
    // roleResolved too, which is only set once the role API call genuinely completes
    // (independent of whether a restaurant was found), so this doesn't redirect on
    // stale/default values.
    if (authLoading || !user || !roleResolved) return

    let cancelled = false
    ;(async () => {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData.session?.access_token
      if (!accessToken || cancelled) return

      try {
        // Destination is decided server-side by the same resolveLoginDestination
        // precedence used by the Google OAuth callback -- see lib/auth/resolve-active-context.ts.
        // May be '/choose-context' if the account has multiple contexts and no
        // valid stored preference -- handled generically below, same as any other destination.
        const response = await fetch('/api/auth/resolve-active-context', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ redirect: searchParams.get('redirect') }),
        })
        const payload = await response.json().catch(() => null)
        if (!cancelled && response.ok && payload?.destination) {
          router.replace(payload.destination)
        }
      } catch {
        // Stay on /signin; user can retry the submit.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [authLoading, user, roleResolved, router, searchParams])

  if (!isSupabaseConfigured) {
    return <SupabaseConfigError />
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      // Prefer FormData over React state so browser autofill values are what we send
      // (controlled inputs can visually show autofill while state lags).
      const form = event.currentTarget
      const formData = new FormData(form)
      const submitEmail = String(formData.get('email') || email).trim()
      const submitPassword = String(formData.get('password') || password)
      await signIn(submitEmail, submitPassword)
      // Redirect handled by the effect above, which calls resolveLoginDestination via
      // /api/auth/resolve-active-context once AuthProvider settles.
    } catch (submitError: any) {
      const message =
        submitError?.message || 'Failed to sign in. Please check your credentials.'
      if (isInvalidCredentialsError(message) && (await shouldShowGoogleHint(email))) {
        setError(`${message}\n\n${GOOGLE_SIGNIN_HINT}`)
      } else {
        setError(message)
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handleGoogleSignIn = async () => {
    setError('')
    setGoogleLoading(true)
    try {
      await signInWithGoogleOAuth(searchParams.get('redirect'))
    } finally {
      setGoogleLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F6F3] text-[#37352F]">
      <Nav />

      <main className="flex min-h-[calc(100vh-64px)] items-center justify-center px-4 pt-20 sm:px-6 lg:px-8">
        <section className="w-full max-w-lg rounded-2xl border border-[#E9E9E7] bg-white p-8 shadow-[0_10px_35px_rgba(55,53,47,0.05)] sm:p-10">
          <h1 className="font-serif text-3xl font-semibold">Sign In</h1>
          <p className="mt-2 text-sm text-[#6B675F]">Access your FlashTap dashboard.</p>

          {resetSuccessMessage ? (
            <p className="mt-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
              {resetSuccessMessage}
            </p>
          ) : null}

          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-[#37352F]">
                Email
              </Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                disabled={submitting || googleLoading}
                placeholder="you@example.com"
                className="rounded-lg border-[#E9E9E7] bg-white text-[#37352F] placeholder:text-[#9B978E]"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-[#37352F]">
                Password
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  disabled={submitting || googleLoading}
                  placeholder="Enter your password"
                  className="rounded-lg border-[#E9E9E7] bg-white pr-11 text-[#37352F] placeholder:text-[#9B978E]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6B675F] hover:text-[#37352F]"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  disabled={submitting || googleLoading}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error ? (
              <p className="whitespace-pre-line rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {displayError}
              </p>
            ) : null}

            <Button
              type="submit"
              disabled={submitting || googleLoading || authLoading}
              className="w-full rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]"
            >
              {submitting ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>

          <AuthDivider />

          <GoogleSignInButton
            disabled={submitting || googleLoading || authLoading}
            onError={setError}
            onClick={handleGoogleSignIn}
          />

          <div className="mt-6 text-sm">
            <Link
              href="/forgot-password"
              className="text-[#6B675F] underline decoration-[#BFBAB0] underline-offset-4 hover:text-[#37352F]"
            >
              Forgot password?
            </Link>
          </div>

          <div className="mt-4 text-sm">
            <Link
              href="/signup"
              className="text-[#6B675F] underline decoration-[#BFBAB0] underline-offset-4 hover:text-[#37352F]"
            >
              Don&apos;t have an account? Sign up
            </Link>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  )
}
