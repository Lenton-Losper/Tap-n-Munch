'use client'

import { useState, type FormEvent } from 'react'
import { Plus } from 'lucide-react'
import { isAuthSessionMissingError, isAuthWeakPasswordError } from '@supabase/auth-js'
import { useAuth } from '@/components/auth/auth-provider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  canAddPasswordCredential,
  getConnectedSignInMethodLabels,
} from '@/lib/auth/capabilities'
import {
  hasPasswordFieldErrors,
  PASSWORD_TOO_SHORT_MESSAGE,
  type PasswordFieldErrors,
  validateNewPasswordPair,
} from '@/lib/auth/password-policy'
import { supabase } from '@/lib/supabase/client'
import { useToast } from '@/hooks/use-toast'
import { SETTINGS_BRAND_PRIMARY, SETTINGS_BRAND_PRIMARY_HOVER } from './constants'

function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true
  if (error && typeof error === 'object' && 'name' in error) {
    return (error as { name: string }).name === 'AuthRetryableFetchError'
  }
  return false
}

function isExpiredSessionError(error: unknown): boolean {
  if (isAuthSessionMissingError(error)) return true
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status
    if (status === 401 || status === 403) return true
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message).toLowerCase()
    return (
      message.includes('jwt') ||
      (message.includes('session') &&
        (message.includes('expired') || message.includes('missing') || message.includes('invalid')))
    )
  }
  return false
}

function resetAddPasswordFormState(setters: {
  setPassword: (value: string) => void
  setConfirmPassword: (value: string) => void
  setFieldErrors: (value: PasswordFieldErrors) => void
  setSubmitError: (value: string) => void
}) {
  setters.setPassword('')
  setters.setConfirmPassword('')
  setters.setFieldErrors({})
  setters.setSubmitError('')
}

export function SettingsSignInMethodsSection() {
  const { user } = useAuth()
  const { toast } = useToast()
  const [addPasswordOpen, setAddPasswordOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<PasswordFieldErrors>({})
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [passwordJustAdded, setPasswordJustAdded] = useState(false)

  if (!user) {
    return null
  }

  const connectedMethods = getConnectedSignInMethodLabels(user)
  const showAddPassword = canAddPasswordCredential(user) && !passwordJustAdded

  const handleDialogOpenChange = (open: boolean) => {
    setAddPasswordOpen(open)
    if (!open && !submitting) {
      resetAddPasswordFormState({
        setPassword,
        setConfirmPassword,
        setFieldErrors,
        setSubmitError,
      })
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitError('')

    const validationErrors = validateNewPasswordPair(password, confirmPassword)
    setFieldErrors(validationErrors)
    if (hasPasswordFieldErrors(validationErrors)) {
      return
    }

    setSubmitting(true)

    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
      if (sessionError || !sessionData.session?.access_token) {
        setSubmitError('Your session has expired. Please sign in again to add a password.')
        return
      }

      const { error } = await supabase.auth.updateUser({
        password,
        data: { has_password_credential: true },
      })

      if (error) {
        if (isExpiredSessionError(error)) {
          setSubmitError('Your session has expired. Please sign in again to add a password.')
          return
        }
        if (isAuthWeakPasswordError(error)) {
          setFieldErrors({ password: error.message || PASSWORD_TOO_SHORT_MESSAGE })
          return
        }
        if (isNetworkFailure(error)) {
          setSubmitError('Network error. Check your connection and try again.')
          return
        }
        setSubmitError(error.message || 'Failed to set password. Please try again.')
        return
      }

      setPasswordJustAdded(true)
      toast({
        title: 'Password added',
        description: 'You can now sign in with your email and password.',
      })
      setAddPasswordOpen(false)
      resetAddPasswordFormState({
        setPassword,
        setConfirmPassword,
        setFieldErrors,
        setSubmitError,
      })
    } catch (error: unknown) {
      if (isExpiredSessionError(error)) {
        setSubmitError('Your session has expired. Please sign in again to add a password.')
        return
      }
      if (isNetworkFailure(error)) {
        setSubmitError('Network error. Check your connection and try again.')
        return
      }
      setSubmitError(
        error instanceof Error ? error.message : 'Failed to set password. Please try again.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className="bg-card border rounded-lg p-6 space-y-6">
        <div>
          <h2 className="text-xl font-semibold">Sign-in Methods</h2>
          <p className="text-sm text-muted-foreground">
            Manage how you sign in to your FlashTap account.
          </p>
        </div>

        {connectedMethods.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sign-in methods found.</p>
        ) : (
          <ul className="space-y-2">
            {connectedMethods.map((label) => (
              <li
                key={label}
                className="rounded-lg border px-4 py-3 text-sm text-foreground"
              >
                {label}
              </li>
            ))}
          </ul>
        )}

        {showAddPassword ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setAddPasswordOpen(true)}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Email &amp; Password
          </Button>
        ) : null}
      </div>

      <Dialog open={addPasswordOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Email &amp; Password</DialogTitle>
            <DialogDescription>
              Set a password so you can sign in with your email address.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="settings-new-password">New password</Label>
              <Input
                id="settings-new-password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                aria-invalid={Boolean(fieldErrors.password)}
              />
              {fieldErrors.password ? (
                <p className="text-sm text-destructive">{fieldErrors.password}</p>
              ) : (
                <p className="text-xs text-muted-foreground">Must be at least 8 characters.</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="settings-confirm-password">Confirm password</Label>
              <Input
                id="settings-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                disabled={submitting}
                aria-invalid={Boolean(fieldErrors.confirmPassword)}
              />
              {fieldErrors.confirmPassword ? (
                <p className="text-sm text-destructive">{fieldErrors.confirmPassword}</p>
              ) : null}
            </div>

            {submitError ? (
              <p className="text-sm text-destructive" role="alert">
                {submitError}
              </p>
            ) : null}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleDialogOpenChange(false)}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="text-white"
                style={{ backgroundColor: SETTINGS_BRAND_PRIMARY }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY_HOVER
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = SETTINGS_BRAND_PRIMARY
                }}
              >
                {submitting ? 'Saving...' : 'Save password'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
