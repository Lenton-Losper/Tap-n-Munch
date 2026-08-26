/**
 * READ ONLY, AND IT WRITES NOTHING TO PRODUCTION. Is POST /api/terminal/held-payments actually
 * deployed and refusing correctly?
 *
 * WHY NOT THE STAGING VERIFICATION. `verify-held-payments-staging.ts` proves the two-sided property
 * by CREATING a restaurant, a terminal and several held_payments rows. That is right on staging and
 * wrong on production: it would seed a financial table with fixtures, which is the exact class of
 * debris that made 37.4% of the orders table unusable for measurement (see
 * docs/the-876-2026-08-26.md). The schema and the behaviour were both proven on staging against the
 * same migration file. What production needs to answer is narrower: did the route ship.
 *
 * A 401 ALONE CANNOT ANSWER IT. "Refused" and "not there" look identical from outside — a missing
 * route on a framework that authenticates first, a worker serving the previous bundle, and a
 * correctly-deployed endpoint rejecting an unauthenticated POST can all produce the same status.
 * A check whose only outcome is "attack refused" cannot tell closed from dead.
 *
 * SO EVERY PROBE HAS A CONTROL:
 *
 *   1. POST /api/terminal/held-payments        no token   -> 401, and NOT 404
 *   2. POST /api/terminal/no-such-route-<rand> no token   -> 404      <- the control. If this also
 *                                                                       returns 401, then 401 means
 *                                                                       nothing on this host and (1)
 *                                                                       proves nothing.
 *   3. POST /api/terminal/held-payments        junk token -> 401, still not 404
 *   4. GET  /api/version                                  -> the SHA actually serving
 *
 * (1) and (2) differing is the whole signal. Both are unauthenticated and neither reaches a write.
 */
const HOSTS = [
  'https://flashtap-production.llosperofficial.workers.dev',
  'https://www.flashtap.app',
  'https://flashtap.app',
  'https://riviera.flashtap.app',
]

const NONCE = Math.random().toString(36).slice(2, 10)

async function post(url, headers = {}) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      // A body that would be REFUSED on validation even if it somehow authenticated: no
      // idempotencyKey, no heldAt. Belt and braces -- the 401 fires long before this is read.
      body: JSON.stringify({ probe: true }),
    })
    return { status: res.status, body: (await res.text()).slice(0, 120) }
  } catch (e) {
    return { status: 0, body: `UNREACHABLE(${String(e.message).slice(0, 60)})` }
  }
}

async function main() {
  console.log('READ ONLY — unauthenticated probes only, nothing is written.\n')
  let failures = 0
  const check = (label, ok, detail = '') => {
    if (!ok) failures++
    console.log(`    ${ok ? 'PASS  ' : '*** FAIL ***  '}${label}${detail ? '   ' + detail : ''}`)
  }

  for (const host of HOSTS) {
    console.log(`  ${host}`)

    let version = '?'
    try {
      const v = await fetch(`${host}/api/version?cb=${Date.now()}`)
      const t = await v.text()
      try {
        const j = JSON.parse(t)
        version = String(j.sha ?? j.gitSha ?? j.commit ?? j.version ?? t).slice(0, 12)
      } catch {
        version = t.trim().slice(0, 40)
      }
    } catch (e) {
      version = `UNREACHABLE(${String(e.message).slice(0, 40)})`
    }
    console.log(`    serving: ${version}`)

    const real = await post(`${host}/api/terminal/held-payments`)
    const control = await post(`${host}/api/terminal/no-such-route-${NONCE}`)
    const junk = await post(`${host}/api/terminal/held-payments`, { Authorization: 'Bearer not-a-real-token' })

    check('the route is NOT 404 — it shipped', real.status !== 404, `got ${real.status}`)
    check('unauthenticated POST is refused 401', real.status === 401, `got ${real.status}`)
    check(
      'CONTROL: a nonexistent terminal route IS 404',
      control.status === 404,
      `got ${control.status}${control.status === 401 ? '  <- 401 means nothing on this host' : ''}`,
    )
    check('the two differ, so 401 is a real answer', real.status !== control.status,
      `${real.status} vs ${control.status}`)
    check('a junk bearer token is also refused', junk.status === 401, `got ${junk.status}`)
    check('no response ever claims stored:true', ![real, junk, control].some((r) => /"stored"\s*:\s*true/.test(r.body)))
    console.log('')
  }

  console.log(failures === 0 ? 'HELD_PAYMENTS_PRODUCTION_PROBE_OK' : `*** ${failures} ASSERTION(S) FAILED ***`)
  if (failures) process.exitCode = 1
}

main()
