#!/usr/bin/env node
/**
 * SMOKE A 0%-TRAFFIC PREVIEW BEFORE PROMOTING IT, AND VERIFY THE BUNDLE ACTUALLY CHANGED.
 *
 * ============================================================================================
 * WHY HTML STATUS CODES ARE NOT ENOUGH, AND HOW THAT WAS LEARNED
 * ============================================================================================
 *
 * /kitchen and /bar are client-rendered behind auth. On 2026-09-01 the preview and the live site
 * returned the SAME 9,811 bytes for /kitchen — byte for byte — while one carried a complete board
 * redesign and the other did not. A 200 proves the Worker boots. It says nothing about what
 * shipped.
 *
 * So this optionally follows the page's own chunk references and greps the JAVASCRIPT for markers.
 * That is where a client-rendered change actually lives.
 *
 * ============================================================================================
 * MARKERS MUST BE TWO-SIDED
 * ============================================================================================
 *
 * `--expect` alone cannot distinguish "the change shipped" from "the probe fetched nothing and
 * found nothing" — an empty bundle satisfies every absence check. So pass `--expect` (strings the
 * NEW build must contain) together with `--absent` (strings only the OLD build had). If the
 * expected markers are present AND the absent ones are gone, the bundle genuinely turned over.
 *
 * Usage:
 *   node scripts/deploy/smoke-preview.mjs <baseUrl> [--expect "a" --expect "b"] [--absent "c"]
 *                                          [--samples 20] [--path /extra]
 *
 * Exit 0 = every path answered without a 5xx and every marker check passed.
 */

const args = process.argv.slice(2)
const baseUrl = args.find((a) => !a.startsWith('--'))
if (!baseUrl) {
  console.error('usage: smoke-preview.mjs <baseUrl> [--expect s] [--absent s] [--samples n] [--path p]')
  process.exit(2)
}

function multi(flag) {
  const out = []
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) out.push(args[i + 1])
  return out
}
function single(flag, fallback) {
  const i = args.indexOf(flag)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}

/** The four the deploy runbook names, plus anything extra the caller asks for. */
const PATHS = ['/api/version', '/', '/kitchen', '/bar', ...multi('--path')]
const EXPECT = multi('--expect')
const ABSENT = multi('--absent')
/**
 * Worker rollout is GRADUAL. A single request can be served by either version for a couple of
 * minutes after a promotion, so one green hit proves nothing about the fleet. Sample and require
 * unanimity.
 */
const SAMPLES = Number(single('--samples', '1')) || 1

let failures = 0
const bust = () => `cb=${Date.now()}_${Math.random().toString(36).slice(2)}`

async function get(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' })
    return { status: res.status, body: await res.text() }
  } catch (err) {
    return { status: 'ERR', body: String(err?.message ?? err) }
  }
}

console.log(`SMOKE ${baseUrl}`)
console.log(`  paths: ${PATHS.join(' ')}`)
if (EXPECT.length || ABSENT.length) {
  console.log(`  markers: expect ${JSON.stringify(EXPECT)}  absent ${JSON.stringify(ABSENT)}`)
}
console.log()

for (let round = 1; round <= SAMPLES; round++) {
  const cells = []
  for (const p of PATHS) {
    const sep = p.includes('?') ? '&' : '?'
    const { status } = await get(`${baseUrl}${p}${sep}${bust()}`)
    const bad = status === 'ERR' || (typeof status === 'number' && status >= 500)
    if (bad) failures++
    cells.push(`${p}=${status}${bad ? ' ***' : ''}`)
  }
  console.log(`  r${String(round).padStart(2)}: ${cells.join('  ')}`)
}

if (EXPECT.length || ABSENT.length) {
  console.log('\nBUNDLE VERIFICATION (JavaScript, not HTML)')
  // Follow the page's own chunk references — including those escaped inside the RSC payload.
  const { body: html } = await get(`${baseUrl}/kitchen?${bust()}`)
  const srcs = new Set()
  for (const m of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+\.js)"/g)) srcs.add(m[1])
  const unescaped = html.split(String.fromCharCode(92)).join('')
  for (const m of unescaped.matchAll(/static\/chunks\/[A-Za-z0-9_.\-%[\]]+\.js/g)) {
    srcs.add(`/_next/${m[0]}`)
  }

  let js = ''
  let fetched = 0
  for (const s of srcs) {
    const { status, body } = await get(`${baseUrl}${s}`)
    if (status === 200) {
      js += body
      fetched++
    }
  }
  console.log(`  chunks referenced ${srcs.size}, fetched ${fetched}, ${js.length} B of JavaScript`)

  if (fetched === 0 || js.length === 0) {
    // Without this, every --absent check would pass vacuously against an empty string.
    console.log('  FAIL: fetched no JavaScript at all — marker checks would be meaningless')
    failures++
  } else {
    for (const m of EXPECT) {
      const ok = js.includes(m)
      if (!ok) failures++
      console.log(`  ${ok ? 'PASS' : 'FAIL'} expected present: ${JSON.stringify(m)}`)
    }
    for (const m of ABSENT) {
      const gone = !js.includes(m)
      if (!gone) failures++
      console.log(`  ${gone ? 'PASS' : 'FAIL'} expected absent : ${JSON.stringify(m)}`)
    }
  }
}

console.log()
if (failures) {
  console.error(`SMOKE FAILED (${failures} problem${failures === 1 ? '' : 's'}). DO NOT PROMOTE.`)
  process.exit(1)
}
console.log('SMOKE CLEAN — no 5xx, markers as expected.')
