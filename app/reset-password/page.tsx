'use client'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import type { AuthChangeEvent, AuthError, Session } from '@supabase/supabase-js'
import { Eye, EyeOff } from 'lucide-react'
import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'
import { SupabaseConfigError } from '@/components/auth/supabase-config-error'
import { useAuth } from '@/components/auth/auth-provider'
import { supabase } from '@/lib/supabase/client'
import { signOutSupabase } from '@/lib/supabase/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type RecoveryStatus = 'checking' | 'ready' | 'invalid'

const INVALID_LINK_MESSAGE =
  'This reset link has expired or already been used. Request a new one.'

function ResetPasswordForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { isSupabaseConfigured } = useAuth()
  const [status, setStatus] = useState<RecoveryStatus>('checking')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const resolvedRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    const markReady = () => {
      if (cancelled) return
      resolvedRef.current = true
      setStatus('ready')
    }

    const markInvalid = () => {
      if (cancelled || resolvedRef.current) return
      setStatus('invalid')
    }

    // Same code-exchange call app/auth/callback/route.ts uses for Google
    // OAuth, adapted to run client-side: this page is reached only via
    // resetPasswordForEmail's redirectTo, so any session established here
    // is a recovery session by construction.
    const code = searchParams.get('code')
    if (code) {
      supabase.auth
        .exchangeCodeForSession(code)
        .then(({ data, error: exchangeError }: { data: { session: Session | null }; error: AuthError | null }) => {
          if (exchangeError || !data.session) {
            markInvalid()
            return
          }
          markReady()
        })
    }

    // createBrowserClient forces flowType: 'pkce', so its automatic
    // detectSessionInUrl only looks for a `?code=` query param — it does
    // NOT parse the older `#access_token=...&type=recovery` hash fragment
    // some recovery links still use. Parse and establish that session
    // ourselves so both delivery formats work.
    if (typeof window !== 'undefined' && window.location.hash.includes('access_token')) {
      const hashParams = new URLSearchParams(window.location.hash.slice(1))
      const accessToken = hashParams.get('access_token')
      const refreshToken = hashParams.get('refresh_token')
      if (accessToken && refreshToken) {
        supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }).then(
          ({ data, error: setSessionError }: { data: { session: Session | null }; error: AuthError | null }) => {
            if (setSessionError || !data.session) {
              markInvalid()
              return
            }
            markReady()
          },
        )
      }
    }

    // Covers cases where Supabase's client already auto-detected the
    // session before this effect ran and fires PASSWORD_RECOVERY for it.
    const { data: authListener } = supabase.auth.onAuthStateChange((event: AuthChangeEvent) => {
      if (event === 'PASSWORD_RECOVERY') {
        markReady()
      }
    })

    // Fallback for either path resolving before this effect's listeners
    // attached, or a plain SIGNED_IN firing instead of PASSWORD_RECOVERY.
    const timeout = setTimeout(async () => {
      if (resolvedRef.current) return
      const { data } = await supabase.auth.getSession()
      if (data.session) {
        markReady()
      } else {
        markInvalid()
      }
    }, 2500)

    return () => {
      cancelled = true
      authListener.subscription.unsubscribe()
      clearTimeout(timeout)
    }
  }, [searchParams])

  if (!isSupabaseConfigured) {
    return <SupabaseConfigError />
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) {
        setError(updateError.message || 'Failed to update password. Please try again.')
        return
      }

      // End the recovery session so /signin shows the success message
      // instead of silently redirecting straight to the dashboard.
      await signOutSupabase().catch(() => {})
      router.replace('/signin?reset=success')
    } catch (submitError: unknown) {
      const message =
        submitError instanceof Error
          ? submitError.message
          : 'Failed to update password. Please try again.'
      setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F6F3] text-[#37352F]">
      <Nav />

      <main className="flex min-h-[calc(100vh-64px)] items-center justify-center px-4 pt-20 sm:px-6 lg:px-8">
        <section className="w-full max-w-lg rounded-2xl border border-[#E9E9E7] bg-white p-8 shadow-[0_10px_35px_rgba(55,53,47,0.05)] sm:p-10">
          <h1 className="font-serif text-3xl font-semibold">Set a new password</h1>

          {status === 'checking' ? (
            <p className="mt-4 text-sm text-[#6B675F]">Verifying your reset link...</p>
          ) : status === 'invalid' ? (
            <>
              <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {INVALID_LINK_MESSAGE}
              </p>
              <div className="mt-6 text-sm">
                <Link
                  href="/forgot-password"
                  className="text-[#6B675F] underline decoration-[#BFBAB0] underline-offset-4 hover:text-[#37352F]"
                >
                  Request a new reset link
                </Link>
              </div>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-[#6B675F]">Choose a new password for your account.</p>

              <form onSubmit={handleSubmit} className="mt-8 space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="password" className="text-[#37352F]">
                    New password
                  </Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      disabled={submitting}
                      placeholder="Enter a new password"
                      className="rounded-lg border-[#E9E9E7] bg-white pr-11 text-[#37352F] placeholder:text-[#9B978E]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6B675F] hover:text-[#37352F]"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      disabled={submitting}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword" className="text-[#37352F]">
                    Confirm new password
                  </Label>
                  <Input
                    id="confirmPassword"
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    required
                    disabled={submitting}
                    placeholder="Confirm your new password"
                    className="rounded-lg border-[#E9E9E7] bg-white text-[#37352F] placeholder:text-[#9B978E]"
                  />
                </div>

                {error ? (
                  <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </p>
                ) : null}

                <Button
                  type="submit"
                  disabled={submitting}
                  className="w-full rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]"
                >
                  {submitting ? 'Updating password...' : 'Update password'}
                </Button>
              </form>
            </>
          )}
        </section>
      </main>

      <Footer />
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#F7F6F3] text-[#6B675F]">
          Loading...
        </div>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  )
}
