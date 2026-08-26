/**
 * STATIC. Does every caller of `requireTerminalAuth` return a thrown auth `Response` unchanged?
 *
 * ============================================================================================
 * THE DEFECT THIS EXISTS BECAUSE OF
 * ============================================================================================
 *
 * `requireTerminalAuth` USED TO throw two different shapes: a `Response` for a missing Bearer
 * header, and whatever jose's `jwtVerify` threw — `JWSInvalid`, `JWSSignatureVerificationFailed`,
 * `JWTExpired` — for a bad token. Callers all handle the first with `if (err instanceof Response)
 * return err` and defaulted the second to their own status: 500 on four routes, **502** on
 * verify-payment and reset-pin.
 *
 * Measured on production 2026-08-26, minutes after deploy, on all four hostnames:
 * `no token -> 401`, `Bearer not-a-real-token -> 500`.
 *
 * WHY THAT IS A DEVICE THAT CANNOT RECOVER. `terminalFetch` refreshes the access token and retries
 * on **401** only. Terminal tokens last one hour, so `JWTExpired` — the ordinary hourly event — was
 * answered with a status the device could not act on, forever, until the app was restarted. On
 * verify-payment that is the "Check payment status" button, which is #327's primary action and the
 * thing #346's over-ceiling copy instructs staff to press.
 *
 * ============================================================================================
 * THE CONTRACT NOW, AND WHY THIS CHECK CHANGED SHAPE
 * ============================================================================================
 *
 * Fixed at the SOURCE rather than in six callers: `requireTerminalAuth` normalises every auth
 * failure to a `Response` — 401 for missing/malformed/forged/expired, 403 for a wrong `type` claim.
 * `scripts/verify-terminal-auth-throw-shapes.ts` asserts all eight shapes against REAL jose with no
 * mock, plus a positive control that a valid token is still accepted.
 *
 * So the question here is no longer "is there a 401 fallback" — the module supplies the status. It
 * is whether the caller lets that Response through. A caller that does not converts every refusal
 * into its own default, and `err instanceof Error` does NOT catch a Response, so the refusal
 * becomes a 500 carrying a stringified object.
 *
 * This is a TEXT scan and reports candidates, not behaviour. It caught a false positive on its
 * first run — a file naming the function only in a doc comment — which is why it strips comments
 * before matching. The behavioural confirmation is the throw-shapes script above and the
 * unauthenticated + junk-token production probe, and the junk-token case is what found the original.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(__dirname, '..')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.next' || name === '.git') return []
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

type Finding = { file: string; status: string; detail: string }

const findings: Finding[] = []
const safe: Finding[] = []

for (const file of walk(join(ROOT, 'app')).concat(walk(join(ROOT, 'lib')))) {
  if (!/\.tsx?$/.test(file)) continue
  const src = readFileSync(file, 'utf8')
  if (file.endsWith('terminal-auth.ts')) continue
  /*
   * CALLS ONLY, NOT MENTIONS. The first version matched the identifier anywhere and reported
   * lib/tabs/resolve-order-member-names.ts, which names `requireTerminalAuth` in a doc comment
   * explaining why the terminal is already authenticated and calls it nowhere. A scan that counts
   * prose as code produces findings that waste the reader's attention -- and the reader stops
   * checking the ones that are real.
   */
  const withoutComments = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  if (!/requireTerminalAuth\s*\(/.test(withoutComments)) continue

  const rel = relative(ROOT, file).replace(/\\/g, '/')

  /*
   * THE CONTRACT CHANGED ON 2026-08-26, AND SO DID THIS CHECK.
   *
   * `requireTerminalAuth` now normalises EVERY auth failure to a `Response` — a missing header, a
   * malformed token, a forged signature and an expired token all leave as 401, and a wrong `type`
   * claim as 403. Verified against real jose, with a positive control, by
   * `scripts/verify-terminal-auth-throw-shapes.ts`.
   *
   * So the question this sweep asks is no longer "is there a 401 fallback" — the module supplies
   * the status. It is: DOES THE CALLER RETURN A THROWN `Response` UNCHANGED? A caller that does not
   * converts every auth refusal into its own default, and `err instanceof Error` does not catch a
   * Response (it is not an Error subclass), so the refusal silently becomes a 500 with a stringified
   * object for a body. `order-requests/[requestId]/release` was exactly that until this commit.
   *
   * A catch that answers 401 itself is also fine — it reaches the same place by another road.
   */
  const catches = [...src.matchAll(/catch\s*\(([^)]*)\)\s*\{/g)]
  if (catches.length === 0) {
    findings.push({ file: rel, status: 'NO CATCH', detail: 'the throw escapes the handler entirely' })
    continue
  }

  let handlesResponse = false
  for (const m of catches) {
    let depth = 1
    let i = m.index! + m[0].length
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++
      else if (src[i] === '}') depth--
      i++
    }
    const body = src.slice(m.index! + m[0].length, i)
    if (/instanceof Response/.test(body)) handlesResponse = true
    else if (/status:\s*401|Unauthorized/.test(body)) handlesResponse = true
  }

  if (handlesResponse) {
    safe.push({ file: rel, status: 'SAFE', detail: 'returns a thrown Response (or answers 401 itself)' })
  } else {
    findings.push({
      file: rel,
      status: 'FINDING',
      detail:
        "no catch returns a thrown Response — every auth refusal becomes this route's default status",
    })
  }
}

console.log(`terminal-auth catch sweep: ${safe.length + findings.length} caller(s) scanned\n`)

if (findings.length) {
  console.log('FINDINGS — a thrown auth Response is swallowed, so the refusal becomes a wrong status:\n')
  for (const f of findings) console.log(`  ${f.file}\n      ${f.detail}`)
  console.log('')
} else {
  console.log('  No findings: every caller returns a thrown auth Response unchanged.\n')
}

console.log(`SAFE (${safe.length}):`)
for (const s of safe) console.log(`  ${s.file}`)

if (findings.length) process.exitCode = 1
