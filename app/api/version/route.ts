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
  // This endpoint is how a deploy is verified, so a cached answer is worse than no
  // answer: a stale edge hit is indistinguishable from a stuck rollout. force-dynamic
  // alone does not stop the edge from caching the RESPONSE -- it only stops Next from
  // prerendering it -- so the response must opt out explicitly. See #192.
  return NextResponse.json(
    { commit: resolveCommitSha() },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    }
  )
}
