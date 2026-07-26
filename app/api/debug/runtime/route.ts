import { NextResponse } from 'next/server'
import { requireStagingPlatformAdmin } from '@/lib/api/require-staging-platform-admin'

export async function GET(request: Request) {
  const denied = await requireStagingPlatformAdmin(request)
  if (denied) return denied

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const projectRef = supabaseUrl.split('.')[0].replace('https://', '')
  return NextResponse.json({
    environment: process.env.ENVIRONMENT,
    supabaseProject: projectRef,
    worker: 'flashtap-staging',
    serviceRoleKeyPrefix: process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0, 40),
  })
}
