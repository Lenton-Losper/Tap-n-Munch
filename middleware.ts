import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

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
 *   Examples: /menu/[restaurantId], /menu/[restaurantId]?table=2, /menu/[restaurantId]/browse, etc.
 * - /signin, /signup, /forgot-password - Authentication pages
 * - /api/public/* - Public API routes (if any)
 * - Static assets (_next, favicon, images, etc.)
 * 
 * PROTECTED ROUTES (require authentication - handled by ProtectedRoute component):
 * - /dashboard - Orders dashboard
 * - /menu-management - Menu management
 * - /analytics - Analytics dashboard
 * - /qr-codes - QR code management
 * - /settings - Settings
 * - / (root) - Admin home page
 * 
 * How it works:
 * 1. The matcher config uses a negative pattern to EXCLUDE public routes from middleware execution
 * 2. If middleware runs (protected route), it allows the request through
 * 3. ProtectedRoute component handles authentication checks for admin routes
 * 4. Menu routes NEVER reach this middleware - they're excluded by the matcher
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // ✅ SAFETY CHECK: Explicitly allow /menu/* routes (should never reach here due to matcher)
  // This is a defensive measure in case the matcher pattern doesn't work as expected
  if (pathname.startsWith('/menu')) {
    return NextResponse.next()
  }

  // This middleware should only run on protected routes
  // Public routes are excluded via the matcher config below
  // If we reach here, it's a protected route - let it through
  // Authentication will be checked by ProtectedRoute component
  
  return NextResponse.next()
}

export const config = {
  matcher: [
    /*
     * ⚠️ CRITICAL: Negative matcher pattern that EXCLUDES public routes
     * 
     * This pattern matches all paths EXCEPT the public routes listed below.
     * If a route matches this pattern, middleware runs (for protected routes).
     * If a route doesn't match, middleware is SKIPPED (public routes).
     * 
     * Excluded routes (public, no auth required, middleware NEVER runs):
     * - /menu/* - ALL customer menu routes (QR codes MUST work without login)
     * - /signin, /signup, /forgot-password - Auth pages
     * - /api/public/* - Public API routes
     * - /_next/* - Next.js internal routes
     * - Static files (images, favicon, etc.)
     * 
     * Pattern explanation:
     * - `/((?!...)` - Match paths starting with / that DON'T match the negative lookahead
     * - `menu|signin|signup|...` - Routes to exclude (public routes)
     * - `.*)` - Match rest of path
     * 
     * This ensures middleware NEVER runs on /menu/* routes,
     * preventing ANY authentication redirects on QR code access.
     */
    '/((?!menu|signin|signup|forgot-password|api/public|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

