'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'
import { FirebaseConfigError } from '@/components/auth/firebase-config-error'
import { useAuth } from '@/components/auth/auth-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { signInWithSupabase } from '@/lib/supabase/auth'

export function SignInClient() {
  const router = useRouter()
  const { user, loading: authLoading, isFirebaseConfigured, signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!authLoading && user) {
      router.replace('/dashboard')
    }
  }, [authLoading, user, router])

  if (!isFirebaseConfigured) {
    return <FirebaseConfigError />
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      await signIn(email, password)

      try {
        const supabaseAuth = await signInWithSupabase(email, password)
        if (typeof window !== 'undefined') {
          localStorage.setItem(
            'supabase_session',
            JSON.stringify(supabaseAuth.session ?? null)
          )
        }
      } catch (supabaseError) {
        console.error('Supabase parallel sign-in failed:', supabaseError)
      }

      router.replace('/dashboard')
    } catch (submitError: any) {
      setError(submitError?.message || 'Failed to sign in. Please check your credentials.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#F7F6F3] text-[#37352F]">
      <Nav />

      <main className="flex min-h-[calc(100vh-64px)] items-center justify-center px-4 pt-20 sm:px-6 lg:px-8">
        <section className="w-full max-w-lg rounded-2xl border border-[#E9E9E7] bg-white p-8 shadow-[0_10px_35px_rgba(55,53,47,0.05)] sm:p-10">
          <h1 className="font-serif text-3xl font-semibold">Sign In</h1>
          <p className="mt-2 text-sm text-[#6B675F]">Access your FlashTap dashboard.</p>

          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
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
                disabled={submitting}
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
                  disabled={submitting}
                  placeholder="Enter your password"
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

            {error ? (
              <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
            ) : null}

            <Button
              type="submit"
              disabled={submitting || authLoading}
              className="w-full rounded-lg bg-[#37352F] text-white hover:bg-[#2f2d27]"
            >
              {submitting ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>

          <div className="mt-6 text-sm">
            <Link
              href="/forgot-password"
              className="text-[#6B675F] underline decoration-[#BFBAB0] underline-offset-4 hover:text-[#37352F]"
            >
              Forgot password?
            </Link>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  )
}

