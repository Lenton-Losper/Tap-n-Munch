import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { resolveLoginDestination } from '@/lib/auth/resolve-active-context'

export const dynamic = 'force-dynamic'

/**
 * Client-facing wrapper around resolveLoginDestination for the email/password
 * sign-in flow (app/signin/signin-client.tsx), which has no server-side
 * request handler of its own to call the shared resolver directly. The
 * Google OAuth callback (app/auth/callback/route.ts) calls resolveLoginDestination
 * directly instead of through this route.
 */
export async function POST(request: Request) {
  try {
    const authUser = await getUserFromRequest(request)
    const body = await request.json().catch(() => ({}))
    const redirectParam = typeof body?.redirect === 'string' ? body.redirect : null

    const resolved = await resolveLoginDestination({ userId: authUser.id, redirectParam })

    if (resolved.kind === 'picker') {
      return NextResponse.json({ destination: '/choose-context' })
    }

    // 'none': no platform_admins row and no restaurant_users row -- not a
    // precedence question, just an account with nothing set up yet. Preserve
    // prior behavior for this path (send to /dashboard, which handles the
    // no-restaurant state itself) rather than inventing a new destination.
    const destination = resolved.kind === 'resolved' ? resolved.destination : '/dashboard'

    return NextResponse.json({ destination })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unauthorized'
    const status = message.includes('authorization') || message.includes('session') ? 401 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
