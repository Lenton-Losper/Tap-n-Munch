/**
 * The customer app must not print a credential to the browser console.
 *
 * THIS SCANS SHIPPED SOURCE, deliberately, and that is unusual enough to justify.
 *
 * The defect it guards is not a behaviour any render test can observe: three `console.log` calls
 * on the QR customer screens printed `flashtap_session_token` — the bearer credential guarding
 * the tab reads, the member rename and ready-to-pay — in plain text, on every mount, on a
 * customer's own phone. Two of them were live on PRODUCTION.
 *
 * It does not widen the attack surface on its own: anything that can read the console on that
 * device can read `localStorage` too, and nothing in this app ships console output off-device
 * (grepped for Sentry / LogRocket / Datadog / Bugsnag / console-hooking — none present, and if
 * one is ever added this stops being merely untidy). It is bad hygiene rather than an exposure,
 * and it is exactly the kind of thing that comes back the next time somebody debugs a session
 * problem at 1am. So the guard is a grep, because a grep is the only thing that can see it.
 *
 * WHAT IT DOES NOT DO: ban console logging. Operational breadcrumbs on the customer screens are
 * left alone. Only the credential-shaped ones are refused, and the list is explicit.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/** Values that must never be an argument to a console call on a customer screen. */
const CREDENTIAL_KEYS = [
  'flashtap_session_token',
  'edit_lock_token',
  'lockToken',
  'tab_pin',
  'flashtap_creator_tab_pin',
]

const CUSTOMER_TREE = join(process.cwd(), 'app', 'menu')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * Console calls, with their arguments, on one line. Crude on purpose: a parser would be more
 * precise and would also be a second thing to maintain, and the failure mode of a crude matcher
 * here is a false positive that someone reads and dismisses -- not a missed credential.
 */
function consoleCallsMentioning(source: string, needle: string): string[] {
  const hits: string[] = []
  for (const line of source.split('\n')) {
    if (!line.includes('console.')) continue
    if (line.includes(needle)) hits.push(line.trim())
  }
  return hits
}

describe('the QR customer screens do not log credentials', () => {
  const files = walk(CUSTOMER_TREE)

  it('finds the customer screens at all, so an empty scan cannot pass silently', () => {
    // Without this, a moved directory turns this whole file into a no-op that reports green --
    // the same shape as a probe that silently matches nothing.
    expect(files.length).toBeGreaterThan(5)
  })

  it.each(CREDENTIAL_KEYS)('never passes %s to a console call', (key) => {
    const offenders: string[] = []
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const line of consoleCallsMentioning(source, key)) {
        offenders.push(`${file.replace(process.cwd(), '')}: ${line}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
