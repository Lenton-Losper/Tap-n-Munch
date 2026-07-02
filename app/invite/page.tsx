'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'
import { useAuth } from '@/components/auth/auth-provider'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type InviteDetails = {
  email: string
  restaurantName: string
  role: string
}

function formatRole(role: string): string {
  const normalized = role.trim().toLowerCase()
  if (normalized === 'manager') return 'Manager'
  if (normalized === 'waiter') return 'Waiter'
  return role
}

function InviteAcceptForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get('token') || ''
  const tokenMissing = !token
  const { signIn } = useAuth()

  const [tokenCheckLoading, setTokenCheckLoading] = useState(() => Boolean(token))
  const [invalid, setInvalid] = useState(false)
  const [invite, setInvite] = useState<InviteDetails | null>(null)
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (tokenMissing) return

    let cancelled = false
    ;(async () => {
      try {
        const response = await fetch(`/api/auth/invite?token=${encodeURIComponent(token)}`)
        const payload = await response.json()
        if (!cancelled) {
          if (payload?.valid) {
            setInvite({
              email: payload.email,
              restaurantName: payload.restaurantName,
              role: payload.role,
            })
          } else {
            setInvalid(true)
          }
        }
      } catch {
        if (!cancelled) setInvalid(true)
      } finally {
        if (!cancelled) setTokenCheckLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [token, tokenMissing])

  const showInvalid = tokenMissing || invalid
  const showLoading = !tokenMissing && tokenCheckLoading

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }

    setSubmitting(true)

    try {
      const response = await fetch('/api/auth/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, fullName: fullName.trim(), password }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to accept invite')
      }

      await signIn(payload.email || invite?.email || '', password)
      router.replace('/dashboard')
    } catch (submitError: unknown) {
      setError(
        submitError instanceof Error ? submitError.message : 'Failed to accept invitation'
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F6F3] text-[#37352F]">
      <Nav />

      <main className="flex min-h-[calc(100vh-64px)] items-center justify-center px-4 pt-20 sm:px-6 lg:px-8">
        <section className="w-full max-w-lg rounded-2xl border border-[#E9E9E7] bg-white p-8 shadow-[0_10px_35px_rgba(55,53,47,0.05)] sm:p-10">
          {showLoading ? (
            <p className="text-sm text-[#6B675F]">Validating your invitation...</p>
          ) : showInvalid || !invite ? (
            <>
              <h1 className="font-serif text-3xl font-semibold">Invitation unavailable</h1>
              <p className="mt-4 text-sm text-[#6B675F]">
                This invite link is invalid or has expired.
              </p>
              <div className="mt-6">
                <Link
                  href="/signin"
                  className="text-sm text-[#6B675F] underline decoration-[#BFBAB0] underline-offset-4 hover:text-[#37352F]"
                >
                  Go to sign in
                </Link>
              </div>
            </>
          ) : (
            <>
              <h1 className="font-serif text-3xl font-semibold">Accept invitation</h1>
              <p className="mt-4 text-sm text-[#6B675F]">
                You&apos;ve been invited to join{' '}
                <strong className="text-[#37352F]">{invite.restaurantName}</strong> as a{' '}
                <strong className="text-[#37352F]">{formatRole(invite.role)}</strong>.
              </p>

              <form onSubmit={handleSubmit} className="mt-8 space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={invite.email}
                    disabled
                    className="rounded-lg border-[#E9E9E7] bg-[#FAFAF8] text-[#6B675F]"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="fullName">Full Name</Label>
                  <Input
                    id="fullName"
                    type="text"
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                    required
                    disabled={submitting}
                    placeholder="Jane Doe"
                    className="rounded-lg border-[#E9E9E7]"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      required
                      disabled={submitting}
                      placeholder="Create a password"
                      className="rounded-lg border-[#E9E9E7] pr-11"
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
                  <Label htmlFor="confirmPassword">Confirm Password</Label>
                  <div className="relative">
                    <Input
                      id="confirmPassword"
                      type={showConfirmPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      required
                      disabled={submitting}
                      placeholder="Confirm your password"
                      className="rounded-lg border-[#E9E9E7] pr-11"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword((prev) => !prev)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6B675F] hover:text-[#37352F]"
                      aria-label={showConfirmPassword ? 'Hide password' : 'Show password'}
                      disabled={submitting}
                    >
                      {showConfirmPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
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
                  {submitting ? 'Creating account...' : 'Accept invitation'}
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

export default function InvitePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#F7F6F3] text-[#6B675F]">
          Loading...
        </div>
      }
    >
      <InviteAcceptForm />
    </Suspense>
  )
}
