import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import {
  isRivieraHost,
  parseTableLandingPath,
  RIVIERA_MENU_PATH,
  RIVIERA_TABLE_LANDING_PATH,
} from '@/lib/riviera-subdomain'

/**
 * Middleware to handle route protection
 *
 * ⚠️ CRITICAL: This middleware MUST allow public access to /menu/* routes
 *
 * Customer-facing menu routes (/menu/*) are PUBLIC and must NEVER require authentication.
 * QR codes point to these routes, and any login requirement breaks the customer flow.
 *
 * PUBLIC ROUTES (accessible without authentication - NO LOGIN REQUIRED):
 * - /menu/* - ALL customer-facing menu routes (QR codes, browsing, cart, checkout, order confirmation)
 * - /table/* - Riviera subdomain table landing URLs (riviera.flashtap.app/table/N)
 * - /signin, /signup, /forgot-password - Authentication pages
 * - /api/public/* - Public API routes (if any)
 * - Static assets (_next, favicon, images, etc.)
 *
 * PROTECTED ROUTES:
 * - /admin/* - Platform admin console (middleware auth guard)
 * - /dashboard, /menu-management, etc. - ProtectedRoute component (client-side)
 */
function handleRivieraSubdomain(request: NextRequest): NextResponse | null {
  if (!isRivieraHost(request.headers.get('host'))) {
    return null
  }

  const { pathname } = request.nextUrl

  if (pathname === '/' || pathname === '') {
    const rewriteUrl = request.nextUrl.clone()
    rewriteUrl.pathname = RIVIERA_MENU_PATH
    rewriteUrl.search = ''
    return NextResponse.rewrite(rewriteUrl)
  }

  // Printed table QRs point at riviera.flashtap.app/table/N. Rewritten into the real
  // /menu/[restaurantId] tree rather than served by app/table/[tableNumber]/page.tsx, which
  // renders the v2 landing OUTSIDE app/menu/[restaurantId]/layout.tsx -- so TabProvider and
  // RestaurantProvider are never mounted and useTab() throws on mount, blanking every scan.
  //
  // A rewrite rather than a duplicate app/table/layout.tsx: one provider tree, so this cannot
  // drift when a provider is added to the menu layout. Rewrite rather than redirect so the
  // customer keeps the short URL in the address bar.
  const tableNumber = parseTableLandingPath(pathname)
  if (tableNumber !== null) {
    const rewriteUrl = request.nextUrl.clone()
    rewriteUrl.pathname = RIVIERA_TABLE_LANDING_PATH
    rewriteUrl.searchParams.set('table', String(tableNumber))
    return NextResponse.rewrite(rewriteUrl)
  }

  return null
}

export async function middleware(request: NextRequest) {
  const rivieraResponse = handleRivieraSubdomain(request)
  if (rivieraResponse) {
    return rivieraResponse
  }

  const { pathname } = request.nextUrl

  // ✅ SAFETY CHECK: Explicitly allow /menu/* routes (should never reach here due to matcher)
  if (pathname.startsWith('/menu')) {
    return NextResponse.next()
  }

  // Protect /admin/* routes with server-side auth
  if (pathname.startsWith('/admin')) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

    const response = NextResponse.next()

    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          )
        },
      },
    })

    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      const signInUrl = new URL('/signin', request.url)
      signInUrl.searchParams.set('redirect', pathname)
      return NextResponse.redirect(signInUrl)
    }

    return response
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!menu|signin|signup|forgot-password|invite|auth|onboarding|api/public|api/media|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
