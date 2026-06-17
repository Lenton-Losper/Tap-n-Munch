import { NextResponse } from 'next/server'
import { validateSessionToken } from './session-token'

export async function requireSessionToken(req: Request): Promise<{
  error?: NextResponse
  tabId?: string
  tableId?: string
  restaurantId?: string
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
  }
}
