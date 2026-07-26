import { NextResponse } from 'next/server'
import { assertPlatformAdmin } from '@/lib/permissions/assert-platform-admin'

/**
 * Debug / dangerous cache tools: platform admin + staging only.
 * Returns an error response, or null when the caller is allowed.
 */
export async function requireStagingPlatformAdmin(request: Request): Promise<NextResponse | null> {
  const env = String(process.env.ENVIRONMENT || process.env.NEXT_PUBLIC_ENVIRONMENT || '')
    .trim()
    .toLowerCase()
  if (env !== 'staging') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  return assertPlatformAdmin(request)
}
