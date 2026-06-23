'use client'

import { Suspense, useEffect, useState } from 'react'
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

function SignUpForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const isGoogleSetup = searchParams.get('google') === 'true'
  const googleName = searchParams.get('name') || ''

  const { user, loading: authLoading, isSupabaseConfigured, signIn } = useAuth()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [restaurantName, setRestaurantName] = useState('')
  const [phone, setPhone] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (isGoogleSetup && googleName) {
      setFullName(decodeURIComponent(googleName))
    }
  }, [isGoogleSetup, googleName])

  useEffect(() => {
    if (authLoading) return
    if (isGoogleSetup) {
      if (!user) {
        router.replace('/signin')
      }
      return
    }
    if (user) {
      router.replace('/dashboard')
    }
  }, [authLoading, user, router, isGoogleSetup])

  if (!isSupabaseConfigured) {
    return <SupabaseConfigError />
  }

  const handleGoogleSignIn = async () => {
    setError('')
    setGoogleLoading(true)
    try {
      await signInWithGoogleOAuth()
    } finally {
      setGoogleLoading(false)
    }
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')

    if (!isGoogleSetup && password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    setSubmitting(true)

    try {
      if (isGoogleSetup) {
        const { data: sessionData } = await supabase.auth.getSession()
        const accessToken = sessionData.session?.access_token

        if (!accessToken) {
          throw new Error('Session expired. Please sign in with Google again.')
        }

        const response = await fetch('/api/auth/create-restaurant', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            restaurantName,
            fullName,
            phone,
          }),
        })

        const payload = await response.json()
        if (!response.ok) {
          throw new Error(payload?.error || 'Failed to complete setup.')
        }

        router.replace('/onboarding')
        return
      }

      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName,
          email,
          password,
          restaurantName,
          phone,
        }),
      })

      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to create account.')
      }

      await signIn(email, password)
      router.replace('/onboarding')
    } catch (submitError: unknown) {
      const message =
        submitError instanceof Error
          ? submitError.message
          : 'Failed to create account. Please try again.'
      setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  const busy = submitting || googleLoading || authLoading

  return (
    <div className="min-h-screen bg-[#F7F6F3] text-[#37352F]">
      <Nav />

      <main className="flex min-h-[calc(100vh-64px)] items-center justify-center px-4 pt-20 sm:px-6 lg:px-8">
        <section className="w-full max-w-lg rounded-2xl border border-[#E9E9E7] bg-white p-8 shadow-[0_10px_35px_rgba(55,53,47,0.05)] sm:p-10">
          <h1 className="font-serif text-3xl font-semibold">
            {isGoogleSetup ? 'Complete Setup' : 'Create Account'}
          </h1>
          <p className="mt-2 text-sm text-[#6B675F]">
            {isGoogleSetup
              ? 'Add your restaurant details to finish setting up FlashTap.'
              : 'Start your FlashTap venue in minutes.'}
          </p>

          {!isGoogleSetup ? (
            <>
              <div className="mt-8">
                <GoogleSignInButton
                  disabled={busy}
                  onError={setError}
                  onClick={handleGoogleSignIn}
                />
              </div>

              <AuthDivider />
            </>
          ) : null}

          <form onSubmit={handleSubmit} className={`space-y-5 ${isGoogleSetup ? 'mt-8' : ''}`}>
            <div className="space-y-2">
              <Label htmlFor="fullName" className="text-[#37352F]">
                Full Name
              </Label>
              <Input
                id="fullName"
                type="text"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                required
                disabled={busy}
                placeholder="Jane Doe"
                className="rounded-lg border-[#E9E9E7] bg-white text-[#37352F] placeholder:text-[#9B978E]"
              />
            </div>

            {!isGoogleSetup ? (
              <>
                <div className="space-y-2">
                  <Label htmlFor="email" className="text-[#37352F]">
                    Email
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    disabled={busy}
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
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      disabled={busy}
                      placeholder="Create a password"
                      className="rounded-lg border-[#E9E9E7] bg-white pr-11 text-[#37352F] placeholder:text-[#9B978E]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((prev) => !prev)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6B675F] hover:text-[#37352F]"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      disabled={busy}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirmPassword" className="text-[#37352F]">
                    Confirm Password
                  </Label>
                  <div className="relative">
                    <Input
                      id="confirmPassword"
                      type={showConfirmPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      required
                      disabled={busy}
                      placeholder="Confirm your password"
                      className="rounded-lg border-[#E9E9E7] bg-white pr-11 text-[#37352F] placeholder:text-[#9B978E]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword((prev) => !prev)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6B675F] hover:text-[#37352F]"
                      aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                      disabled={busy}
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>
              </>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="restaurantName" className="text-[#37352F]">
                Restaurant Name
              </Label>
              <Input
                id="restaurantName"
                type="text"
                value={restaurantName}
                onChange={(event) => setRestaurantName(event.target.value)}
                required
                disabled={busy}
                placeholder="The Riverside Bistro"
                className="rounded-lg border-[#E9E9E7] bg-white text-[#37352F] placeholder:text-[#9B978E]"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone" className="text-[#37352F]">
                Phone
              </Label>
              <Input
                id="phone"
                type="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                disabled={busy}
                placeholder="+264 81 123 4567"
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
              disabled={busy}
              className="w-full rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]"
            >
              {submitting
                ? isGoogleSetup
                  ? 'Completing setup...'
                  : 'Creating account...'
                : isGoogleSetup
                  ? 'Complete Setup'
                  : 'Create Account'}
            </Button>
          </form>

          {!isGoogleSetup ? (
            <div className="mt-6 text-sm">
              <Link
                href="/signin"
                className="text-[#6B675F] underline decoration-[#BFBAB0] underline-offset-4 hover:text-[#37352F]"
              >
                Already have an account? Sign in
              </Link>
            </div>
          ) : null}
        </section>
      </main>

      <Footer />
    </div>
  )
}

export default function SignUpPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#F7F6F3] text-[#6B675F]">
          Loading...
        </div>
      }
    >
      <SignUpForm />
    </Suspense>
  )
}
