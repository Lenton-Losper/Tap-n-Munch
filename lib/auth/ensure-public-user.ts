import type { SupabaseClient } from '@supabase/supabase-js'

const LOG_PREFIX = '[auth/callback ensure-public-user]'

export type EnsurePublicUserResult =
  | { ok: true }
  | { ok: false; code: 'missing_email' | 'email_collision_unresolved' | 'insert_failed'; message: string }

type PublicUserRow = {
  id: string
  email: string | null
}

/**
 * Every FK referencing public.users(id) — sourced from information_schema on production
 * (ihlmmpmolnpchzgwyhgh, 2026-07-09). Update this list when migrations add new FKs.
 */
export const PUBLIC_USERS_FOREIGN_KEY_REFERENCES = [
  {
    table: 'authorization_events',
    column: 'actor_user_id',
    constraint: 'authorization_events_actor_user_id_fkey',
  },
  {
    table: 'business_documents',
    column: 'created_by',
    constraint: 'business_documents_created_by_fkey',
  },
  {
    table: 'goods_received',
    column: 'received_by',
    constraint: 'goods_received_received_by_fkey',
  },
  {
    table: 'inventory_movements',
    column: 'created_by',
    constraint: 'inventory_movements_created_by_fkey',
  },
  {
    table: 'payment_events',
    column: 'initiated_by',
    constraint: 'payment_events_initiated_by_fkey',
  },
  {
    table: 'privileged_authorization_tokens',
    column: 'user_id',
    constraint: 'privileged_authorization_tokens_user_id_fkey',
  },
  {
    table: 'restaurant_invites',
    column: 'invited_by',
    constraint: 'restaurant_invites_invited_by_fkey',
  },
  {
    table: 'restaurant_users',
    column: 'invited_by',
    constraint: 'restaurant_users_invited_by_fkey',
  },
  {
    table: 'restaurant_users',
    column: 'user_id',
    constraint: 'restaurant_users_user_id_fkey',
  },
  {
    table: 'restaurants',
    column: 'created_by',
    constraint: 'restaurants_created_by_fkey',
  },
  {
    table: 'restaurants',
    column: 'owner_id',
    constraint: 'restaurants_owner_id_fkey',
  },
  {
    table: 'staff_invites',
    column: 'invited_by',
    constraint: 'staff_invites_invited_by_fkey',
  },
  {
    table: 'stock_movements',
    column: 'created_by',
    constraint: 'stock_movements_created_by_fkey',
  },
  {
    table: 'terminal_authorization_credentials',
    column: 'user_id',
    constraint: 'terminal_authorization_credentials_user_id_fkey',
  },
] as const

export type PublicUserFkReference = (typeof PUBLIC_USERS_FOREIGN_KEY_REFERENCES)[number]

export type PublicUserReferenceHit = {
  table: string
  column: string
  constraint: string
  count: number
}

function isUniqueEmailViolation(error: { code?: string; message?: string }): boolean {
  if (error.code === '23505') return true
  const message = String(error.message || '').toLowerCase()
  return (
    message.includes('users_email_key') ||
    (message.includes('duplicate key') && message.includes('email'))
  )
}

export async function findPublicUserReferences(
  adminSupabase: SupabaseClient,
  userId: string,
): Promise<PublicUserReferenceHit[]> {
  const hits: PublicUserReferenceHit[] = []

  for (const ref of PUBLIC_USERS_FOREIGN_KEY_REFERENCES) {
    const { count, error } = await adminSupabase
      .from(ref.table)
      .select('*', { count: 'exact', head: true })
      .eq(ref.column, userId)

    if (error) {
      console.error(LOG_PREFIX, 'FK reference check failed', {
        userId,
        table: ref.table,
        column: ref.column,
        constraint: ref.constraint,
        error,
      })
      throw error
    }

    if ((count ?? 0) > 0) {
      hits.push({
        table: ref.table,
        column: ref.column,
        constraint: ref.constraint,
        count: count ?? 0,
      })
    }
  }

  return hits
}

/**
 * A stale orphan public.users row blocks OAuth callback insert via users_email_key.
 * Same shape as the three production rows remediated manually for #35.
 *
 * "Safe to delete" is decided entirely by findPublicUserReferences below (which already
 * checks restaurant_users.user_id, among every other FK into public.users) -- no separate
 * users.restaurant_id check is needed on top of that.
 */
export async function isStaleOrphanPublicUser(
  adminSupabase: SupabaseClient,
  staleRow: PublicUserRow,
  authUserId: string,
): Promise<boolean> {
  if (staleRow.id === authUserId) return false

  const { data: authMatch, error: authLookupError } = await adminSupabase.auth.admin.getUserById(
    staleRow.id,
  )
  if (authLookupError) {
    const isNotFound = authLookupError.status === 404 || authLookupError.code === 'user_not_found'
    if (!isNotFound) {
      console.error(LOG_PREFIX, 'auth lookup for stale row failed', {
        staleUserId: staleRow.id,
        error: authLookupError,
      })
      return false
    }
    // No auth.users row backs this id — confirms the public.users row is orphaned.
  } else if (authMatch.user?.id) {
    return false
  }

  try {
    const referenceHits = await findPublicUserReferences(adminSupabase, staleRow.id)
    if (referenceHits.length > 0) {
      console.warn(LOG_PREFIX, 'stale-row candidate has public.users FK references', {
        staleUserId: staleRow.id,
        referenceHits,
      })
      return false
    }
    return true
  } catch {
    return false
  }
}

export async function ensurePublicUserForOAuth(
  adminSupabase: SupabaseClient,
  params: {
    id: string
    email: string | undefined
    fullName: string
    avatarUrl: string | null
  },
): Promise<EnsurePublicUserResult> {
  const email = String(params.email || '').trim()
  if (!email) {
    console.error(LOG_PREFIX, 'OAuth user missing email; cannot create public.users', {
      authUserId: params.id,
    })
    return { ok: false, code: 'missing_email', message: 'OAuth account is missing an email address' }
  }

  const { data: existingById, error: existingByIdError } = await adminSupabase
    .from('users')
    .select('id')
    .eq('id', params.id)
    .maybeSingle()

  if (existingByIdError) {
    console.error(LOG_PREFIX, 'lookup by auth user id failed', {
      authUserId: params.id,
      error: existingByIdError,
    })
    return { ok: false, code: 'insert_failed', message: existingByIdError.message }
  }

  if (existingById?.id) {
    return { ok: true }
  }

  const insertPayload = {
    id: params.id,
    email,
    full_name: params.fullName || null,
    avatar_url: params.avatarUrl,
  }

  const { error: insertError } = await adminSupabase.from('users').insert(insertPayload)

  if (!insertError) {
    console.info(LOG_PREFIX, 'inserted public.users for new OAuth user', { authUserId: params.id, email })
    return { ok: true }
  }

  if (!isUniqueEmailViolation(insertError)) {
    console.error(LOG_PREFIX, 'insert failed', { authUserId: params.id, email, error: insertError })
    return { ok: false, code: 'insert_failed', message: insertError.message }
  }

  console.warn(LOG_PREFIX, 'users_email_key collision on insert; inspecting existing row', {
    authUserId: params.id,
    email,
    error: insertError,
  })

  const { data: existingByEmail, error: existingByEmailError } = await adminSupabase
    .from('users')
    .select('id, email')
    .ilike('email', email)
    .maybeSingle()

  if (existingByEmailError || !existingByEmail?.id) {
    console.error(LOG_PREFIX, 'email collision but no public.users row found', {
      authUserId: params.id,
      email,
      lookupError: existingByEmailError,
    })
    return {
      ok: false,
      code: 'insert_failed',
      message: existingByEmailError?.message || 'Email collision could not be resolved',
    }
  }

  const staleOrphan = await isStaleOrphanPublicUser(adminSupabase, existingByEmail, params.id)
  if (!staleOrphan) {
    let referenceHits: PublicUserReferenceHit[] = []
    try {
      referenceHits = await findPublicUserReferences(adminSupabase, existingByEmail.id)
    } catch {
      // logged in findPublicUserReferences
    }

    console.error(LOG_PREFIX, 'email collision with non-orphan public.users row; manual review required', {
      authUserId: params.id,
      email,
      existingPublicUserId: existingByEmail.id,
      referenceHits,
      fkChecksPerformed: PUBLIC_USERS_FOREIGN_KEY_REFERENCES.length,
    })
    return {
      ok: false,
      code: 'email_collision_unresolved',
      message: 'An existing profile already uses this email. Contact support.',
    }
  }

  console.warn(LOG_PREFIX, 'reconciling stale orphan public.users row', {
    authUserId: params.id,
    email,
    stalePublicUserId: existingByEmail.id,
    fkChecksPerformed: PUBLIC_USERS_FOREIGN_KEY_REFERENCES.length,
  })

  const { error: deleteError } = await adminSupabase.from('users').delete().eq('id', existingByEmail.id)
  if (deleteError) {
    console.error(LOG_PREFIX, 'failed to delete stale orphan public.users row', {
      authUserId: params.id,
      stalePublicUserId: existingByEmail.id,
      error: deleteError,
    })
    return { ok: false, code: 'insert_failed', message: deleteError.message }
  }

  const { error: reinsertError } = await adminSupabase.from('users').insert(insertPayload)
  if (reinsertError) {
    console.error(LOG_PREFIX, 'reinsert after stale orphan delete failed', {
      authUserId: params.id,
      email,
      error: reinsertError,
    })
    return { ok: false, code: 'insert_failed', message: reinsertError.message }
  }

  console.info(LOG_PREFIX, 'reconciled stale orphan and inserted public.users', {
    authUserId: params.id,
    email,
    removedStalePublicUserId: existingByEmail.id,
  })
  return { ok: true }
}
