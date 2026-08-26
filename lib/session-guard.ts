import { NextResponse } from 'next/server'
import { validateSessionToken } from './session-token'

export async function requireSessionToken(req: Request): Promise<{
  error?: NextResponse
  tabId?: string
  tableId?: string
  restaurantId?: string
  /** Passed through from validateSessionToken's own join -- see the note there on why. */
  tabStatus?: string
}> {
  const token = req.headers.get('x-session-token')

  if (!token) {
    return {
      error: NextResponse.json(
        { error: 'Session token required. Please scan the QR code again.' },
        { status: 410 }
      ),
    }
  }

  const validation = await validateSessionToken(token)

  if (!validation.valid) {
    return {
      error: NextResponse.json(
        {
          error: 'Your dining session has ended. Please scan the QR code to start a new order.',
          reason: validation.reason,
        },
        { status: 410 }
      ),
    }
  }

  return {
    tabId: validation.tabId,
    tableId: validation.tableId,
    restaurantId: validation.restaurantId,
    tabStatus: validation.tabStatus,
  }
}

/**
 * Bind a validated session token to the restaurant/tab the request claims to act on.
 * Prevents reusing Restaurant A's token against Restaurant B's IDs.
 */
export function assertSessionMatchesResource(
  guard: { restaurantId?: string; tabId?: string },
  expected: { restaurantId?: string | null; tabId?: string | null },
): NextResponse | null {
  const tokenRestaurant = String(guard.restaurantId || '').trim()
  const tokenTab = String(guard.tabId || '').trim()
  const wantRestaurant = String(expected.restaurantId || '').trim()
  const wantTab = String(expected.tabId || '').trim()

  if (wantRestaurant && tokenRestaurant && wantRestaurant !== tokenRestaurant) {
    return NextResponse.json(
      { error: 'Session token does not match this restaurant' },
      { status: 403 },
    )
  }

  if (wantTab && tokenTab && wantTab !== tokenTab) {
    return NextResponse.json(
      { error: 'Session token does not match this tab' },
      { status: 403 },
    )
  }

  return null
}
