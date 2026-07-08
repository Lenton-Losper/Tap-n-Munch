import type { User } from '@supabase/supabase-js'

import { canAddPasswordCredential } from '@/lib/auth/capabilities'

function userWithIdentities(
  identities: User['identities'],
): User {
  return { identities } as User
}

describe('canAddPasswordCredential', () => {
  test('returns true for a Google-only user', () => {
    const user = userWithIdentities([
      {
        id: '1',
        user_id: 'user-1',
        identity_id: 'google-id',
        provider: 'google',
      },
    ])

    expect(canAddPasswordCredential(user)).toBe(true)
  })

  test('returns false for an email/password-only user', () => {
    const user = userWithIdentities([
      {
        id: '1',
        user_id: 'user-1',
        identity_id: 'email-id',
        provider: 'email',
      },
    ])

    expect(canAddPasswordCredential(user)).toBe(false)
  })

  test('returns false for a Google + password user', () => {
    const user = userWithIdentities([
      {
        id: '1',
        user_id: 'user-1',
        identity_id: 'google-id',
        provider: 'google',
      },
      {
        id: '2',
        user_id: 'user-1',
        identity_id: 'email-id',
        provider: 'email',
      },
    ])

    expect(canAddPasswordCredential(user)).toBe(false)
  })

  test('returns false when identities is missing', () => {
    expect(canAddPasswordCredential({} as User)).toBe(false)
  })

  test('returns false when identities is not an array', () => {
    expect(canAddPasswordCredential({ identities: null } as unknown as User)).toBe(false)
    expect(canAddPasswordCredential({ identities: undefined } as User)).toBe(false)
  })

  test('ignores null identity entries and returns true when only OAuth providers exist', () => {
    const user = userWithIdentities([
      null as unknown as NonNullable<User['identities']>[number],
      { id: '1', user_id: 'user-1', identity_id: 'google-id', provider: 'google' },
    ])

    expect(canAddPasswordCredential(user)).toBe(true)
  })
})
