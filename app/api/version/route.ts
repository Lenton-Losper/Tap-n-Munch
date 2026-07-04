import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

function resolveCommitSha(): string | null {
  const candidates = [
    process.env.GIT_COMMIT_SHA,
    process.env.NEXT_PUBLIC_COMMIT_SHA,
    process.env.CF_PAGES_COMMIT_SHA,
  ]
  for (const value of candidates) {
    if (value && value !== 'unknown') return value
  }
  return null
}

export async function GET() {
  return NextResponse.json({ commit: resolveCommitSha() })
}
