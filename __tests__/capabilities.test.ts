import type { User } from '@supabase/supabase-js'

import {
  canAddPasswordCredential,
  getConnectedSignInMethodLabels,
  HAS_PASSWORD_CREDENTIAL_METADATA_KEY,
} from '@/lib/auth/capabilities'

function userWithIdentities(
  identities: User['identities'],
  userMetadata?: User['user_metadata'],
): User {
  return { identities, user_metadata: userMetadata } as User
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

  test('returns false when user_metadata.has_password_credential is true without email identity', () => {
    const user = userWithIdentities(
      [
        {
          id: '1',
          user_id: 'user-1',
          identity_id: 'google-id',
          provider: 'google',
        },
      ],
      { [HAS_PASSWORD_CREDENTIAL_METADATA_KEY]: true },
    )

    expect(canAddPasswordCredential(user)).toBe(false)
  })

  test('returns true when neither email identity nor has_password_credential metadata exists', () => {
    const user = userWithIdentities(
      [
        {
          id: '1',
          user_id: 'user-1',
          identity_id: 'google-id',
          provider: 'google',
        },
      ],
      {},
    )

    expect(canAddPasswordCredential(user)).toBe(true)
  })
})

describe('getConnectedSignInMethodLabels', () => {
  test('includes Email & Password when metadata flag is set but no email identity exists', () => {
    const user = userWithIdentities(
      [
        {
          id: '1',
          user_id: 'user-1',
          identity_id: 'google-id',
          provider: 'google',
        },
      ],
      { [HAS_PASSWORD_CREDENTIAL_METADATA_KEY]: true },
    )

    expect(getConnectedSignInMethodLabels(user)).toEqual([
      'Google — Connected',
      'Email & Password — Connected',
    ])
  })
})
