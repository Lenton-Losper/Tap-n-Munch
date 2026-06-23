import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { createServerSupabaseClient } from '@/lib/supabase/server'

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
      const { data: existingUser } = await adminSupabase
        .from('users')
        .select('id')
        .eq('id', user.id)
        .maybeSingle()

      const fullName =
        String(user.user_metadata?.full_name || user.user_metadata?.name || '').trim()

      if (!existingUser) {
        await adminSupabase.from('users').insert({
          id: user.id,
          email: user.email,
          full_name: fullName || null,
          avatar_url: user.user_metadata?.avatar_url || null,
        })

        return NextResponse.redirect(
          `${origin}/signup?google=true&name=${encodeURIComponent(fullName)}`
        )
      }

      const { data: membership } = await adminSupabase
        .from('restaurant_users')
        .select('restaurant_id')
        .eq('user_id', user.id)
        .maybeSingle()

      if (membership?.restaurant_id) {
        return NextResponse.redirect(`${origin}/dashboard`)
      }

      return NextResponse.redirect(
        `${origin}/signup?google=true&name=${encodeURIComponent(fullName)}`
      )
    }
  }

  return NextResponse.redirect(`${origin}/signin?error=oauth`)
}
