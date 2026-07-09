import type { User } from '@supabase/supabase-js'

/**
 * Fallback metadata flag set when a user adds a password via Settings.
 * Needed because Supabase Auth does not create an `email` identity row on
 * `updateUser({ password })` for OAuth-only users (upstream bugs, not fixed in
 * hosted Auth as of 2026-07):
 * - https://github.com/supabase/auth/issues/2085
 * - https://github.com/supabase/auth/issues/2320
 * Keep checking `identity.provider === 'email'` as the primary signal so this
 * fallback can be removed once upstream ships the fix.
 */
export const HAS_PASSWORD_CREDENTIAL_METADATA_KEY = 'has_password_credential' as const

function hasPasswordCredentialMetadata(user: User): boolean {
  return user.user_metadata?.[HAS_PASSWORD_CREDENTIAL_METADATA_KEY] === true
}

/**
 * Whether the user already has an email/password credential (Supabase identity provider `email`).
 * Callers must use {@link canAddPasswordCredential} instead of inspecting `user.identities`.
 */
function hasPasswordCredential(user: User): boolean {
  if (hasPasswordCredentialMetadata(user)) {
    return true
  }

  if (!Array.isArray(user.identities)) {
    return false
  }

  return user.identities.some(
    (identity) => identity != null && identity.provider === 'email',
  )
}

/**
 * True when the user can add an email/password sign-in method.
 * Returns false when a password credential already exists or identity data is missing/malformed.
 */
export function canAddPasswordCredential(user: User): boolean {
  if (hasPasswordCredential(user)) {
    return false
  }

  if (!Array.isArray(user.identities)) {
    return false
  }

  return true
}

const SIGN_IN_METHOD_LABELS: Record<string, string> = {
  email: 'Email & Password',
  google: 'Google',
  apple: 'Apple',
  azure: 'Microsoft',
  github: 'GitHub',
}

function signInMethodLabel(provider: string): string {
  return SIGN_IN_METHOD_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

/**
 * Human-readable connected sign-in methods for Settings UI (e.g. "Google — Connected").
 * Callers must use this instead of inspecting `user.identities`.
 */
export function getConnectedSignInMethodLabels(user: User): string[] {
  if (!Array.isArray(user.identities)) {
    return hasPasswordCredentialMetadata(user)
      ? [`${signInMethodLabel('email')} — Connected`]
      : []
  }

  const seen = new Set<string>()
  const labels: string[] = []

  for (const identity of user.identities) {
    if (identity == null || typeof identity.provider !== 'string') {
      continue
    }
    if (seen.has(identity.provider)) {
      continue
    }
    seen.add(identity.provider)
    labels.push(`${signInMethodLabel(identity.provider)} — Connected`)
  }

  // Metadata fallback: password works but no `email` identity row yet (see HAS_PASSWORD_CREDENTIAL_METADATA_KEY).
  if (hasPasswordCredentialMetadata(user) && !seen.has('email')) {
    labels.push(`${signInMethodLabel('email')} — Connected`)
  }

  return labels
}
