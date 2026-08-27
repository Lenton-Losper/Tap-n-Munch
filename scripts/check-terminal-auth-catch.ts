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
 *
 * ============================================================================================
 * THREE WAYS IT COULD NOT FAIL, ALL FIXED 2026-08-27
 * ============================================================================================
 *
 * Found by mutation while auditing every check-* gate. Each is annotated at the code that fixes it.
 *
 *   PER FILE, NOT PER HANDLER   one boolean per file, true if ANY catch anywhere returned a thrown
 *                               Response — so one correct handler vouched for every sibling. A
 *                               route with a good GET and a bad POST read as clean.
 *   COMMENTS COUNTED AS CODE    the caller detection stripped comments; the CATCH BODIES were
 *                               sliced out of the raw source. A guard that had merely been
 *                               commented out still satisfied the check for that guard, which is
 *                               the likeliest way a guard ever stops running.
 *   ZERO CALLERS PRINTED OK     "0 caller(s) scanned" followed by "every caller returns a thrown
 *                               auth Response unchanged", exit 0. Renaming the helper would have
 *                               produced a permanent, confident all-clear over nothing.
 *
 * The scan reports per HANDLER now (`route.ts [POST]`), reads from comment-stripped source, fails
 * on an empty input, and reports rather than skips any call it cannot attribute to a handler —
 * that last one immediately caught a real mistake in the rewrite, five handlers whose destructured
 * `{ params }` signature had been mistaken for the function body.
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

/** Strip comments. Kept off `//` inside `://` so a URL literal is not mangled. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** The balanced `{...}` block beginning at the first `{` at or after `from`. */
function blockAfter(src: string, from: number): string {
  const open = src.indexOf('{', from)
  if (open === -1) return ''
  let depth = 0
  let i = open
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  return src.slice(open + 1)
}

/**
 * THE UNIT OF JUDGEMENT IS THE HANDLER, NOT THE FILE. Fixed 2026-08-27.
 *
 * `handlesResponse` was one boolean per FILE, set true if ANY catch anywhere in it returned a
 * thrown Response. A route file exports several handlers, so one correct handler vouched for all
 * of them. Verified by mutation on app/api/terminal/printer-config/route.ts, which has GET, POST
 * and DELETE each with the guard: deleting ONLY the POST guard (line 140) left the sweep reporting
 *
 *     No findings: every caller returns a thrown auth Response unchanged.
 *
 * while POST turned every 401 into its own default -- which is the exact defect this exists for,
 * and the one that left terminals unable to recover from an ordinary hourly token expiry.
 *
 * A route's HTTP handlers are the callers, so each is scored separately. Anything reached outside a
 * handler -- helpers under lib/ -- is scored as one module-level unit, unchanged.
 */
function unitsOf(src: string): { label: string; body: string }[] {
  const units: { label: string; body: string }[] = []
  const re = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    /*
     * SKIP THE PARAMETER LIST BEFORE LOOKING FOR THE BODY. Next.js route handlers destructure
     * their second argument -- `{ params }: { params: Promise<{ orderId: string }> }` -- so the
     * first `{` after the handler name belongs to the SIGNATURE, not the function body. Taking it
     * as the body yielded a slice containing no `requireTerminalAuth` call, and five real handlers
     * came back UNATTRIBUTED on the first run of this rewrite.
     *
     * They were reported rather than skipped, which is the only reason the mistake was visible at
     * all -- a scan that silently drops what it cannot attribute would have shown 24 green callers
     * and hidden five.
     */
    const paren = m.index + m[0].length - 1
    let depth = 0
    let i = paren
    for (; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1
      else if (src[i] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    units.push({ label: m[1], body: blockAfter(src, i) })
  }
  return units.length ? units : [{ label: '<module>', body: src }]
}

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
  const withoutComments = stripComments(src)
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
  /*
   * READ FROM THE COMMENT-STRIPPED SOURCE. Fixed 2026-08-27, and it was the sharper of the two
   * bugs here: the caller-detection above already stripped comments (the docblock explains why),
   * but the catch bodies were sliced out of the RAW `src`. So a guard that had merely been
   * COMMENTED OUT still satisfied the check for that guard. Verified by deleting the real guard
   * from all three handlers of printer-config/route.ts and leaving one line reading
   *
   *     // if (err instanceof Response) return err   -- commented out during a refactor
   *
   * The sweep answered "No findings: every caller returns a thrown auth Response unchanged."
   * Commenting a guard out is the single likeliest way it stops running, and it was the one edit
   * this scan could not see.
   */
  let sawAuthUnit = false
  for (const unit of unitsOf(withoutComments)) {
    if (!/requireTerminalAuth\s*\(/.test(unit.body)) continue
    sawAuthUnit = true
    const where = unit.label === '<module>' ? rel : `${rel} [${unit.label}]`

    const catches = [...unit.body.matchAll(/catch\s*\(([^)]*)\)\s*\{/g)]
    if (catches.length === 0) {
      findings.push({ file: where, status: 'NO CATCH', detail: 'the throw escapes the handler entirely' })
      continue
    }

    let handlesResponse = false
    for (const m of catches) {
      const body = blockAfter(unit.body, m.index! + m[0].length - 1)
      if (/instanceof Response/.test(body)) handlesResponse = true
      else if (/status:\s*401|Unauthorized/.test(body)) handlesResponse = true
    }

    if (handlesResponse) {
      safe.push({ file: where, status: 'SAFE', detail: 'returns a thrown Response (or answers 401 itself)' })
    } else {
      findings.push({
        file: where,
        status: 'FINDING',
        detail:
          "no catch returns a thrown Response — every auth refusal becomes this route's default status",
      })
    }
  }

  /*
   * The file calls requireTerminalAuth but no UNIT did -- the call sits outside every exported
   * handler and outside the module fallback, which should be impossible. Reported rather than
   * skipped: a caller this scan cannot attribute is a caller it is not checking, and silently
   * dropping it is how a sweep ends up reporting on fewer files than it claims.
   */
  if (!sawAuthUnit) {
    findings.push({
      file: rel,
      status: 'UNATTRIBUTED',
      detail: 'calls requireTerminalAuth but the call could not be placed in any handler — not checked',
    })
  }
}

console.log(`terminal-auth catch sweep: ${safe.length + findings.length} caller(s) scanned\n`)

/*
 * ZERO CALLERS IS A BROKEN SCAN, NOT A CLEAN ONE. Added 2026-08-27.
 *
 * Until this, finding nothing printed
 *
 *     terminal-auth catch sweep: 0 caller(s) scanned
 *       No findings: every caller returns a thrown auth Response unchanged.
 *
 * and exited 0. Verified by pointing the detection regex at a renamed helper -- which is not a
 * hypothetical edit, it is what a rename to `requireTerminalSession` would do. The sentence is
 * false in the most complete way available: it reports on callers it never found, and its output
 * is indistinguishable from a genuinely clean sweep.
 *
 * There are 25 callers today. A floor of 1 is enough to make the difference detectable without
 * pinning a count that ordinary work would churn.
 */
if (safe.length + findings.length === 0) {
  console.error('\ncheck-terminal-auth-catch: FAILED — zero callers found.\n')
  console.error(
    'This sweep exists to check the callers of requireTerminalAuth, and it found none. There are\n' +
      '25 in the repo, so this means the scan is broken, not that the tree is clean — the helper\n' +
      'was renamed, moved out of app/ or lib/, or the call pattern changed.\n\n' +
      'An all-clear over an empty input is the worst thing a checker can print, because it is\n' +
      'indistinguishable from a real one. Fix the scan, or delete it if the helper is gone.\n',
  )
  process.exit(1)
}

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
