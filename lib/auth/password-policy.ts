/** Matches invite accept + signup API enforcement (minimum 8 characters). */
export const MIN_PASSWORD_LENGTH = 8

export const PASSWORD_TOO_SHORT_MESSAGE = 'Password must be at least 8 characters.'
export const PASSWORDS_DO_NOT_MATCH_MESSAGE = 'Passwords do not match.'

export type PasswordFieldErrors = {
  password?: string
  confirmPassword?: string
}

export function validateNewPasswordPair(
  password: string,
  confirmPassword: string,
): PasswordFieldErrors {
  const errors: PasswordFieldErrors = {}

  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = PASSWORD_TOO_SHORT_MESSAGE
  }

  if (password !== confirmPassword) {
    errors.confirmPassword = PASSWORDS_DO_NOT_MATCH_MESSAGE
  }

  return errors
}

export function hasPasswordFieldErrors(errors: PasswordFieldErrors): boolean {
  return Boolean(errors.password || errors.confirmPassword)
}
