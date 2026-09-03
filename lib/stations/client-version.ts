/**
 * WHAT BUNDLE THIS SCREEN IS ACTUALLY RUNNING (#373).
 *
 * ============================================================================================
 * WHY THE CLIENT REPORTS THIS AND NOT THE SERVER
 * ============================================================================================
 *
 * The heartbeat route could read the commit sha out of its own environment and stamp it, which
 * would be one less request. It would also be a lie. A wall screen keeps running whatever bundle
 * it loaded until somebody reloads it — that is the entire failure mode this exists to expose. A
 * screen that has been up since Tuesday is running Tuesday's code no matter how many times we have
 * deployed since, and a server-stamped version would report today's and hide exactly the staleness
 * anyone is looking for.
 *
 * So the value is captured ONCE, at load, from the deployment that served this page, and never
 * refreshed. It changes only when the page does, which is the property that makes it meaningful.
 *
 * ============================================================================================
 * WHY NOT NEXT_PUBLIC_COMMIT_SHA
 * ============================================================================================
 *
 * It is passed as a Worker `--var` at DEPLOY time, not at build time, so it never reaches the
 * client bundle — `process.env.NEXT_PUBLIC_COMMIT_SHA` is undefined in the browser. /api/version
 * is where that value actually lives, and reading it once per session is the honest way to get it.
 *
 * FAILS TO null, NEVER THROWS. This is diagnostics: a screen that cannot report its version must
 * still show the pass.
 */
let cached: string | null | undefined

/** Short form — a full 40-char sha is unreadable in a terminals list. */
function short(sha: string): string {
  const trimmed = sha.trim()
  return trimmed.length > 12 ? trimmed.slice(0, 8) : trimmed
}

export async function getClientVersion(): Promise<string | null> {
  if (cached !== undefined) return cached
  try {
    const res = await fetch('/api/version', { cache: 'no-store' })
    if (!res.ok) {
      cached = null
      return cached
    }
    const body = (await res.json()) as { commit?: unknown }
    const commit = typeof body.commit === 'string' ? short(body.commit) : ''
    cached = commit || null
  } catch {
    cached = null
  }
  return cached
}

/** Test seam: the module-level cache would otherwise leak between cases. */
export function resetClientVersionForTest(): void {
  cached = undefined
}
