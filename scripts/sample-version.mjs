/**
 * Sample /api/version across the production hostnames. READ ONLY.
 *
 * WHY SAMPLING AND NOT ONE HIT. For roughly two minutes after `wrangler deploy`, a Cloudflare
 * worker serves BOTH the old and the new bundle depending on which colo answers. Measured
 * 2026-08-18 on the 5c9d31d -> 632d00d deploy: `flashtap.app` returned the NEW version, then the
 * OLD one twenty seconds later, on a route that already sends `Cache-Control: no-store`. So a
 * single cache-busted check can read either way by luck.
 *
 * THE DANGEROUS DIRECTION IS THE FALSE PASS: one lucky sample hitting a rolled-over colo reads as
 * "deployed and verified" while most real traffic is still served the previous build, and any
 * post-deploy probe run at that moment is testing an unknown bundle.
 *
 * So each hostname is sampled N times with a changing cache-buster and must come back UNANIMOUS.
 * A mixed count means still rolling, not failed.
 *
 * `flashtap-production.llosperofficial.workers.dev` is listed FIRST deliberately: it answered with
 * the new SHA before any custom domain did, so it is the earliest honest signal that the upload
 * landed at all.
 *
 * AND A HOST THAT DOES NOT ANSWER IS PRINTED, NOT SWALLOWED. A poll loop that only pattern-matches
 * the body treats "no response" and "wrong SHA" identically -- which is how a watcher once polled a
 * hostname that does not resolve for thirteen minutes and looked like a slow deploy.
 *
 * Usage:
 *   node scripts/sample-version.mjs            # 20 samples per host
 *   node scripts/sample-version.mjs 5          # 5 samples per host (baseline capture)
 */
const HOSTS = [
  'https://flashtap-production.llosperofficial.workers.dev',
  'https://flashtap.app',
  'https://www.flashtap.app',
  'https://riviera.flashtap.app',
]

const N = Number(process.argv[2] || 20)

async function sampleOnce(host, i) {
  const url = `${host}/api/version?cb=${Date.now()}-${i}`
  try {
    const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } })
    const text = await res.text()
    if (!res.ok) return `HTTP_${res.status}`
    try {
      const j = JSON.parse(text)
      return String(j.sha ?? j.gitSha ?? j.commit ?? j.version ?? text).slice(0, 12)
    } catch {
      return text.trim().slice(0, 40) || `EMPTY_BODY_${res.status}`
    }
  } catch (e) {
    return `UNREACHABLE(${String(e.message).slice(0, 40)})`
  }
}

async function main() {
  console.log(`sampling /api/version, ${N}x per host\n`)
  let allUnanimous = true

  for (const host of HOSTS) {
    const counts = new Map()
    for (let i = 0; i < N; i++) {
      const v = await sampleOnce(host, i)
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }
    const entries = [...counts].sort((a, b) => b[1] - a[1])
    const unanimous = entries.length === 1 && !entries[0][0].startsWith('UNREACHABLE') && !entries[0][0].startsWith('HTTP_')
    if (!unanimous) allUnanimous = false
    console.log(
      `  ${host.replace('https://', '').padEnd(48)} ` +
        entries.map(([v, n]) => `${v}=${n}`).join('  ') +
        (unanimous ? `   ${N}/${N} OK` : entries.length > 1 ? '   *** MIXED — still rolling ***' : '   *** NOT SERVING ***'),
    )
  }

  console.log('')
  console.log(allUnanimous ? 'VERSION_SAMPLE_UNANIMOUS' : 'VERSION_SAMPLE_NOT_UNANIMOUS')
  if (!allUnanimous) process.exitCode = 1
}

main()
