import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { ensurePublicUserForOAuth } from '@/lib/auth/ensure-public-user'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

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

      const { data: membership, error: membershipError } = await adminSupabase
        .from('restaurant_users')
        .select('restaurant_id')
        .eq('user_id', user.id)
        .maybeSingle()

      if (membershipError) {
        console.error('[auth/callback] restaurant_users lookup failed', {
          authUserId: user.id,
          error: membershipError,
        })
        return NextResponse.redirect(`${origin}/signin?error=oauth`)
      }

      if (membership?.restaurant_id) {
        return NextResponse.redirect(`${origin}/dashboard`)
      }

      return NextResponse.redirect(
        `${origin}/signup?google=true&name=${encodeURIComponent(fullName)}`
      )
    }

    if (error) {
      console.error('[auth/callback] exchangeCodeForSession failed', { error })
    }
  }

  return NextResponse.redirect(`${origin}/signin?error=oauth`)
}
