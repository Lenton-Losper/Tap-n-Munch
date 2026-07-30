/**
 * Focused, repeated repro of the tab-members lost update (STAGING ONLY).
 *
 * app/api/tabs/join/route.ts:55-70 reads tabs.members, appends one entry in JS, and writes
 * the whole array back with no version check and no DB-side append. Concurrent joins -- the
 * ordinary case when a group scans the table QR at the same time -- overwrite each other.
 *
 * Runs the scenario several times so the result is a rate, not a single anecdote.
 *
 *   npx tsx scripts/qr-audit-repro-member-lost-update.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const BASE = process.env.QR_AUDIT_BASE || 'http://localhost:3101'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TABLE = 9105
const JOINERS = 4 // plus the host = 5 expected members
const TRIALS = 5

async function trial(n: number) {
  const hostSid = `qr-audit-lu-host-${randomUUID()}`
  const create = await fetch(`${BASE}/api/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: RID, tableNumber: TABLE, sessionId: hostSid, displayName: 'Host' }),
  })
  const tab = await create.json()
  if (!tab?.tabId) return { trial: n, error: JSON.stringify(tab).slice(0, 160) }

  // The join route authenticates with the tab PIN; read the real one rather than guessing
  // at a response field, and record the starting member count so the delta is unambiguous.
  const { data: seed } = await admin.from('tabs').select('tab_pin, members').eq('id', tab.tabId).single()
  const pin = String(seed?.tab_pin ?? '')
  const before = Array.isArray(seed?.members) ? seed.members.length : 0
  if (!pin) return { trial: n, error: 'tab has no PIN; cannot join' }

  // Everyone scans at once.
  const joins = await Promise.all(
    Array.from({ length: JOINERS }, (_, i) =>
      fetch(`${BASE}/api/tabs/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          restaurantId: RID,
          tableNumber: TABLE,
          tabId: tab.tabId,
          pin,
          sessionId: `qr-audit-lu-j${i}-${randomUUID()}`,
          displayName: `Guest${i + 1}`,
        }),
      }).then((r) => r.status),
    ),
  )

  // Only joins the server ACCEPTED should be expected to appear.
  const accepted = joins.filter((s) => s === 200).length

  const { data } = await admin.from('tabs').select('members').eq('id', tab.tabId).single()
  const recorded = Array.isArray(data?.members) ? data.members.length : 0
  const expected = before + accepted

  // Close the tab so staging is not left with open audit tabs.
  await admin.from('tabs').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', tab.tabId)

  return {
    trial: n,
    joinHttpStatuses: joins,
    joinsAccepted: accepted,
    membersBefore: before,
    expectedMembers: expected,
    recordedMembers: recorded,
    lost: expected - recorded,
    verdict:
      accepted === 0
        ? 'INCONCLUSIVE -- server rejected every join, nothing was tested'
        : recorded === expected
          ? 'ok'
          : 'LOST UPDATE',
  }
}

async function main() {
  console.log(`=== tab members lost-update repro -- ${TRIALS} trials, ${JOINERS} concurrent joins each ===`)
  const results = []
  for (let i = 1; i <= TRIALS; i++) {
    const r = await trial(i)
    console.log(JSON.stringify(r))
    results.push(r)
  }
  const bad = results.filter((r) => r.verdict === 'LOST UPDATE')
  console.log(`\nSUMMARY: ${bad.length}/${TRIALS} trials lost members.`)
  if (bad.length) {
    const totalLost = bad.reduce((s, r) => s + r.lost, 0)
    console.log(`members silently dropped across all trials: ${totalLost}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
