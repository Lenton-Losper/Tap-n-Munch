import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const commit =
    process.env.GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_COMMIT_SHA ||
    process.env.CF_PAGES_COMMIT_SHA ||
    null

  return NextResponse.json({ commit })
}
