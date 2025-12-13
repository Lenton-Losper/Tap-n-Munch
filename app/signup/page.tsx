'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/components/auth/auth-provider'
import { FirebaseConfigError } from '@/components/auth/firebase-config-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Eye, EyeOff, ArrowLeft, Check } from 'lucide-react'

export default function SignUpPage() {
  const router = useRouter()
  const { user, loading: authLoading, isFirebaseConfigured, signUp } = useAuth()
  const [formData, setFormData] = useState({
    restaurantName: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
  })
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    if (!authLoading && user) {
      router.push('/')
    }
  }, [user, authLoading, router])

  if (authLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#FF6B35]"></div>
      </div>
    )
  }

  if (!isFirebaseConfigured) {
    return <FirebaseConfigError />
  }

  if (user) {
    return null
  }

  // Password validation
  const passwordChecks = {
    minLength: formData.password.length >= 8,
    hasUpperCase: /[A-Z]/.test(formData.password),
    hasLowerCase: /[a-z]/.test(formData.password),
    hasNumber: /[0-9]/.test(formData.password),
  }

  const isPasswordValid = Object.values(passwordChecks).every(Boolean)
  const passwordsMatch = formData.password === formData.confirmPassword && formData.confirmPassword.length > 0

  // Check username availability (simple check - just validates format)
  const checkUsername = (email: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    setUsernameAvailable(emailRegex.test(email))
  }

  const handleChange = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }))
    if (field === 'email') {
      checkUsername(value)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!isPasswordValid) {
      setError('Please meet all password requirements')
      return
    }

    if (!passwordsMatch) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)

    try {
      console.log('🚀 Starting signup process...', {
        email: formData.email,
        restaurantName: formData.restaurantName,
      })
      
      await signUp(
        formData.email,
        formData.password,
        formData.restaurantName,
        formData.phone
      )
      
      console.log('✅ Signup successful! Redirecting to dashboard...')
      
      // Wait a moment for auth state to update
      setTimeout(() => {
        router.push('/dashboard')
      }, 500)
    } catch (err: any) {
      console.error('❌ Signup error:', {
        error: err,
        message: err.message,
        stack: err.stack,
      })
      setError(err.message || 'Failed to create account. Please try again.')
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Create Account</h1>
          <p className="text-gray-600 mb-6">
            Sign up to start managing your restaurant
          </p>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="restaurantName">Restaurant Name *</Label>
              <Input
                id="restaurantName"
                type="text"
                placeholder="e.g., Tap n Munch"
                value={formData.restaurantName}
                onChange={(e) => handleChange('restaurantName', e.target.value)}
                required
                disabled={loading}
                className="w-full"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={formData.email}
                onChange={(e) => handleChange('email', e.target.value)}
                required
                disabled={loading}
                className="w-full"
              />
              {formData.email && usernameAvailable !== null && (
                <div className={`flex items-center gap-2 text-sm ${
                  usernameAvailable ? 'text-green-600' : 'text-red-600'
                }`}>
                  {usernameAvailable ? (
                    <>
                      <Check className="w-4 h-4" />
                      <span>Email is valid</span>
                    </>
                  ) : (
                    <span>Please enter a valid email address</span>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number *</Label>
              <div className="flex">
                <span className="inline-flex items-center px-3 rounded-l-md border border-r-0 border-gray-300 bg-gray-50 text-gray-500 text-sm">
                  +
                </span>
                <Input
                  id="phone"
                  type="tel"
                  placeholder="234 567 8900"
                  value={formData.phone}
                  onChange={(e) => handleChange('phone', e.target.value)}
                  required
                  disabled={loading}
                  className="w-full rounded-l-none"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password *</Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Create a password"
                  value={formData.password}
                  onChange={(e) => handleChange('password', e.target.value)}
                  required
                  disabled={loading}
                  className="w-full pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                  disabled={loading}
                >
                  {showPassword ? (
                    <EyeOff className="w-5 h-5" />
                  ) : (
                    <Eye className="w-5 h-5" />
                  )}
                </button>
              </div>
              {formData.password && (
                <div className="space-y-1 mt-2">
                  {Object.entries(passwordChecks).map(([key, isValid]) => (
                    <div
                      key={key}
                      className={`flex items-center gap-2 text-sm ${
                        isValid ? 'text-green-600' : 'text-gray-500'
                      }`}
                    >
                      {isValid ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <span className="w-4 h-4 flex items-center justify-center">○</span>
                      )}
                      <span>
                        {key === 'minLength' && 'At least 8 characters'}
                        {key === 'hasUpperCase' && 'One uppercase letter'}
                        {key === 'hasLowerCase' && 'One lowercase letter'}
                        {key === 'hasNumber' && 'One number'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm Password *</Label>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  placeholder="Confirm your password"
                  value={formData.confirmPassword}
                  onChange={(e) => handleChange('confirmPassword', e.target.value)}
                  required
                  disabled={loading}
                  className="w-full pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
                  disabled={loading}
                >
                  {showConfirmPassword ? (
                    <EyeOff className="w-5 h-5" />
                  ) : (
                    <Eye className="w-5 h-5" />
                  )}
                </button>
              </div>
              {formData.confirmPassword && (
                <div className={`flex items-center gap-2 text-sm ${
                  passwordsMatch ? 'text-green-600' : 'text-red-600'
                }`}>
                  {passwordsMatch ? (
                    <>
                      <Check className="w-4 h-4" />
                      <span>Passwords match</span>
                    </>
                  ) : (
                    <span>Passwords do not match</span>
                  )}
                </div>
              )}
            </div>

            {error && (
              <div className="text-sm text-red-600 bg-red-50 p-3 rounded-md">
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="w-full bg-[#FF6B35] hover:bg-[#e55a28] text-white"
              disabled={loading || !isPasswordValid || !passwordsMatch}
            >
              {loading ? 'Creating Account...' : 'Start Free Trial'}
            </Button>
          </form>

          <div className="mt-6 text-center">
            <p className="text-sm text-gray-600">
              Already have an account?{' '}
              <Link
                href="/signin"
                className="font-medium text-[#FF6B35] hover:text-[#e55a28]"
              >
                Sign In
              </Link>
            </p>
          </div>

          <div className="mt-6 pt-6 border-t border-gray-200">
            <Link
              href="/"
              className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Home
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

