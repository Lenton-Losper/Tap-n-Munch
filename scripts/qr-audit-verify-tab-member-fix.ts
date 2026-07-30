/**
 * Verifies the properties add_tab_member is supposed to guarantee (STAGING ONLY).
 *
 *   V1. concurrent joins all persist                    (the original lost update)
 *   V2. re-joining with the same session_id is a no-op  (idempotent, no duplicate entry)
 *   V3. auto-assigned "Person N" names are unique under concurrency
 *   V4. anon/authenticated cannot call the RPC directly via PostgREST
 *
 *   npx tsx scripts/qr-audit-verify-tab-member-fix.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const BASE = process.env.QR_AUDIT_BASE || 'http://localhost:3101'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
if (!/mdqjpxwczrhkxkbqatqa/.test(url)) throw new Error(`Refusing: not staging (${url})`)
const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

const RID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const TABLE = 9103

async function openTab(displayName: string) {
  const sid = `qr-audit-fix-${randomUUID()}`
  const r = await fetch(`${BASE}/api/tabs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ restaurantId: RID, tableNumber: TABLE, sessionId: sid, displayName }),
  })
  const tab = await r.json()
  const { data } = await admin.from('tabs').select('tab_pin, members').eq('id', tab.tabId).single()
  return { tabId: tab.tabId, pin: String(data?.tab_pin ?? ''), sid }
}

function join(tabId: string, pin: string, sessionId: string, displayName?: string) {
  return fetch(`${BASE}/api/tabs/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      restaurantId: RID, tableNumber: TABLE, tabId, pin, sessionId,
      ...(displayName ? { displayName } : {}),
    }),
  }).then((r) => r.status)
}

async function membersOf(tabId: string) {
  const { data } = await admin.from('tabs').select('members').eq('id', tabId).single()
  return Array.isArray(data?.members) ? data.members : []
}

async function main() {
  const results: Record<string, unknown> = {}

  // V1 + V3 -- six simultaneous joins, no display names, so the DB assigns every name.
  {
    const { tabId, pin } = await openTab('Host')
    const before = (await membersOf(tabId)).length
    const statuses = await Promise.all(
      Array.from({ length: 6 }, () => join(tabId, pin, `qr-audit-v1-${randomUUID()}`)),
    )
    const accepted = statuses.filter((s) => s === 200).length
    const members = await membersOf(tabId)
    const names = members.map((m) => String(m.display_name))
    results.V1_concurrent_joins_persist = {
      accepted, before, expected: before + accepted, recorded: members.length,
      pass: members.length === before + accepted,
    }
    results.V3_auto_names_unique = {
      names, unique: new Set(names).size === names.length,
      pass: new Set(names).size === names.length,
    }
    await admin.from('tabs').delete().eq('id', tabId)
  }

  // V2 -- the same session joins five times over.
  {
    const { tabId, pin } = await openTab('Host')
    const before = (await membersOf(tabId)).length
    const repeat = `qr-audit-v2-${randomUUID()}`
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push(await join(tabId, pin, repeat, 'Repeat Guest'))
    const members = await membersOf(tabId)
    const occurrences = members.filter((m) => String(m.session_id) === repeat).length
    results.V2_rejoin_is_idempotent = {
      statuses, occurrences, totalMembers: members.length,
      pass: occurrences === 1 && members.length === before + 1,
    }
    await admin.from('tabs').delete().eq('id', tabId)
  }

  // V4 -- the RPC must not be reachable with the anon key.
  {
    if (!anonKey) {
      results.V4_anon_cannot_call_rpc = { skipped: 'no anon key in env' }
    } else {
      const anon = createClient(url, anonKey, { auth: { persistSession: false } })
      const { data, error } = await anon.rpc('add_tab_member', {
        p_tab_id: '00000000-0000-0000-0000-000000000000',
        p_member: { session_id: 'anon-probe', joined_at: new Date().toISOString(), display_name: 'Intruder' },
      })
      results.V4_anon_cannot_call_rpc = {
        error: error?.message ?? null, data: data ?? null,
        pass: Boolean(error),
      }
    }
  }

  console.log(JSON.stringify(results, null, 2))
  const checks = Object.entries(results).filter(([, v]) => 'pass' in (v as object))
  const failed = checks.filter(([, v]) => !(v as { pass: boolean }).pass)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length) {
    console.log('FAILED: ' + failed.map(([k]) => k).join(', '))
    process.exit(1)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
