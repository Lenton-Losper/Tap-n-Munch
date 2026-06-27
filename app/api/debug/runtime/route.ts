import { NextResponse } from 'next/server'

export async function GET() {
  if (process.env.ENVIRONMENT !== 'staging') {
    return NextResponse.json({ error: 'Not available' }, { status: 404 })
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const projectRef = supabaseUrl.split('.')[0].replace('https://', '')
  return NextResponse.json({
    environment: process.env.ENVIRONMENT,
    supabaseProject: projectRef,
    worker: 'flashtap-staging',
    serviceRoleKeyPrefix: process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(0, 40),
  })
}
