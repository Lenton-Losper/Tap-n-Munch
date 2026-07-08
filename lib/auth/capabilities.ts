import type { User } from '@supabase/supabase-js'

/**
 * Whether the user already has an email/password credential (Supabase identity provider `email`).
 * Callers must use {@link canAddPasswordCredential} instead of inspecting `user.identities`.
 */
function hasPasswordCredential(user: User): boolean {
  if (!Array.isArray(user.identities)) {
    return false
  }

  return user.identities.some(
    (identity) => identity != null && identity.provider === 'email',
  )
}

/**
 * True when the user can add an email/password sign-in method (no existing `email` identity).
 * Returns false when a password credential already exists or identity data is missing/malformed.
 */
export function canAddPasswordCredential(user: User): boolean {
  if (!Array.isArray(user.identities)) {
    return false
  }

  return !hasPasswordCredential(user)
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
    return []
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

  return labels
}
