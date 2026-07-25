import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { ensurePublicUserForOAuth } from '@/lib/auth/ensure-public-user'
import { syncUserEmailAcrossTables } from '@/lib/auth/sync-user-email'
import { resolveLoginDestination } from '@/lib/auth/resolve-active-context'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const type = searchParams.get('type')
  const redirectParam = searchParams.get('redirect')

  // Secure Email Change requires confirming from BOTH the new and current
  // inbox. The first of the two links GoTrue sends produces no `code` --
  // just a message in the URL hash telling the user to also check their
  // other inbox (hash fragments never reach the server) -- so this
  // intermediate state must be detected here, before the code-exchange
  // branch below, which would otherwise fall through to a confusing
  // "/signin?error=oauth" redirect for what is actually an expected step.
  if (type === 'email_change' && !code) {
    const linkError = searchParams.get('error') || searchParams.get('error_code')
    if (linkError) {
      console.error('[auth/callback] email_change link error', {
        error: linkError,
        description: searchParams.get('error_description'),
      })
      return NextResponse.redirect(`${origin}/settings?error=email_change_link#profile`)
    }
    return NextResponse.redirect(`${origin}/settings?email_change_pending=1#profile`)
  }

  if (code) {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          },
        },
      }
    )

    const { data, error } = await supabase.auth.exchangeCodeForSession(code)
    const user = data.user

    if (!error && user && type === 'email_change') {
      const newEmail = String(user.email || '').trim()
      if (!newEmail) {
        console.error('[auth/callback] email_change confirmation missing user.email', { authUserId: user.id })
        return NextResponse.redirect(`${origin}/settings?error=email_change#profile`)
      }

      const syncResult = await syncUserEmailAcrossTables(user.id, newEmail)
      if (!syncResult.ok) {
        console.error('[auth/callback] email-change sync failed', {
          authUserId: user.id,
          syncResult,
        })
        return NextResponse.redirect(`${origin}/settings?error=email_change_sync#profile`)
      }

      return NextResponse.redirect(`${origin}/settings?email_changed=1#profile`)
    }

    if (!error && user) {
      const adminSupabase = createServerSupabaseClient()
      const fullName =
        String(user.user_metadata?.full_name || user.user_metadata?.name || '').trim()

      const ensured = await ensurePublicUserForOAuth(adminSupabase, {
        id: user.id,
        email: user.email,
        fullName,
        avatarUrl: user.user_metadata?.avatar_url || null,
      })

      if (!ensured.ok) {
        console.error('[auth/callback] ensurePublicUserForOAuth failed', {
          authUserId: user.id,
          email: user.email,
          code: ensured.code,
          message: ensured.message,
        })
        return NextResponse.redirect(`${origin}/signin?error=oauth_profile`)
      }

      let resolved
      try {
        resolved = await resolveLoginDestination({ userId: user.id, redirectParam })
      } catch (resolveError) {
        console.error('[auth/callback] resolveLoginDestination failed', {
          authUserId: user.id,
          error: resolveError,
        })
        return NextResponse.redirect(`${origin}/signin?error=oauth`)
      }

      if (resolved.kind === 'none') {
        return NextResponse.redirect(
          `${origin}/signup?google=true&name=${encodeURIComponent(fullName)}`
        )
      }

      if (resolved.kind === 'picker') {
        return NextResponse.redirect(`${origin}/choose-context`)
      }

      return NextResponse.redirect(`${origin}${resolved.destination}`)
    }

    if (error) {
      console.error('[auth/callback] exchangeCodeForSession failed', { error })
    }
  }

  return NextResponse.redirect(`${origin}/signin?error=oauth`)
}
