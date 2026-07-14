import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

/**
 * Whether to show the "signed up with Google" hint after an invalid-credentials
 * sign-in error (#34). Only true for confirmed Google-only accounts, so a
 * wrong-password attempt on an account that also has a password credential
 * doesn't get a misleading hint. Always returns false on any lookup error —
 * under-hinting is the safe failure mode here, not over-hinting.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json()
    const email = String(body?.email || '').trim()

    if (!email) {
      return NextResponse.json({ showGoogleHint: false })
    }

    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase.rpc('should_show_google_signin_hint', {
      p_email: email,
    })

    if (error) {
      console.error('[signin-hint] lookup failed', { error })
      return NextResponse.json({ showGoogleHint: false })
    }

    return NextResponse.json({ showGoogleHint: data === true })
  } catch (error) {
    console.error('[signin-hint] failed', { error })
    return NextResponse.json({ showGoogleHint: false })
  }
}
