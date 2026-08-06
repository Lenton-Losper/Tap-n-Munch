/**
 * Issue #176 — Clear Table, exercised END TO END against staging.
 *
 * The whole point of the feature is that after clearing, the next customer scans the SAME
 * printed QR code and starts fresh with no PIN prompt. Until now that was established only by
 * reading close_table_session and the session-version check in lib/session-token.ts. Reading
 * code is not evidence that a scan works.
 *
 * This drives the real route handlers against the real staging database:
 *   1. create a table
 *   2. scan -> a tab is opened, with a PIN, at session version V
 *   3. clear the table
 *   4. scan again with a DIFFERENT customer session -> a NEW tab, and the scanner is its
 *      creator rather than someone challenged for the previous tab's PIN
 *
 * Everything created is removed in afterAll, including on failure.
 */
import { createStagingAdmin, STAGING_TEST_RESTAURANT_ID } from './helpers/staging-auth-fixtures'
import { closeTableSession } from '@/lib/session-manager'

const admin = createStagingAdmin()

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => admin,
}))

// The route pulls in the browser client transitively; it constructs at import time and needs
// NEXT_PUBLIC_* env that CI does not have. Nothing under test uses it.
jest.mock('@/lib/supabase/client', () => ({
  getSupabaseClient: () => ({}),
  supabase: {},
}))

// Above every band in use (dining < 5000, view-only 5000+, kiosk 9000+) so a leak is obvious.
const TABLE_NUMBER = 72001
const TAG = 'clear-table-e2e'

let tableId: string | null = null

async function scan(sessionId: string) {
  const { POST } = await import('@/app/api/tabs/route')
  const res = await POST(
    new Request('http://localhost/api/tabs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        restaurantId: STAGING_TEST_RESTAURANT_ID,
        tableNumber: TABLE_NUMBER,
        sessionId,
        displayName: 'E2E Person',
      }),
    }),
  )
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function tableRow() {
  const { data } = await admin
    .from('restaurant_tables')
    .select('id, status, current_session_version')
    .eq('id', tableId!)
    .maybeSingle()
  return data as { id: string; status: string; current_session_version: number } | null
}

beforeAll(async () => {
  await admin
    .from('restaurant_tables')
    .delete()
    .eq('restaurant_id', STAGING_TEST_RESTAURANT_ID)
    .eq('table_number', TABLE_NUMBER)

  const { data, error } = await admin
    .from('restaurant_tables')
    .insert({
      restaurant_id: STAGING_TEST_RESTAURANT_ID,
      table_number: TABLE_NUMBER,
      table_name: `${TAG}-${TABLE_NUMBER}`,
      is_kiosk: false,
      is_view_only: false,
      active: true,
    })
    .select('id')
    .single()

  if (error) throw new Error(`could not create the E2E table: ${error.message}`)
  tableId = String(data.id)
}, 60000)

afterAll(async () => {
  if (!tableId) return
  const { data: tabs } = await admin.from('tabs').select('id').eq('table_id', tableId)
  const tabIds = (tabs ?? []).map((t) => String(t.id))
  if (tabIds.length > 0) {
    await admin.from('customer_sessions').delete().in('tab_id', tabIds)
    await admin.from('tabs').delete().in('id', tabIds)
  }
  await admin.from('restaurant_tables').delete().eq('id', tableId)
}, 60000)

describe('#176 scan -> clear -> scan again, on staging', () => {
  test('the same QR yields a FRESH tab after clearing, with no PIN challenge', async () => {
    // --- 1. First customer scans -------------------------------------------------------
    const first = await scan('e2e-session-before-clear')
    expect(first.status).toBeLessThan(400)

    const firstTabId = String(
      (first.body.tab as Record<string, unknown> | undefined)?.id ?? first.body.tabId ?? '',
    )
    expect(firstTabId).not.toEqual('')

    const { data: firstTab } = await admin
      .from('tabs')
      .select('id, status, tab_pin, pin_required')
      .eq('id', firstTabId)
      .maybeSingle()
    expect(firstTab?.status).toBe('open')

    const before = await tableRow()
    expect(before).not.toBeNull()

    // --- 2. Clear the table -------------------------------------------------------------
    await closeTableSession({
      supabase: admin,
      restaurantId: STAGING_TEST_RESTAURANT_ID,
      tableId: tableId!,
      closedBy: 'e2e',
      source: 'dashboard',
    })

    // The tab is settled, not deleted -- history is preserved.
    const { data: settledTab } = await admin
      .from('tabs')
      .select('status, settled_type')
      .eq('id', firstTabId)
      .maybeSingle()
    expect(settledTab?.status).toBe('settled')
    expect(settledTab?.settled_type).toBe('manual_close')

    // Every session on the old tab is dead. This is what makes the old QR session invalid.
    const { data: oldSessions } = await admin
      .from('customer_sessions')
      .select('active')
      .eq('tab_id', firstTabId)
    for (const s of oldSessions ?? []) expect(s.active).toBe(false)

    // The version bump is the mechanism lib/session-token.ts:120 checks.
    const after = await tableRow()
    expect(after!.current_session_version).toBe(before!.current_session_version + 1)
    expect(after!.status).toBe('available')

    // --- 3. Next customer scans the SAME code -------------------------------------------
    const second = await scan('e2e-session-after-clear')
    expect(second.status).toBeLessThan(400)

    const secondTabId = String(
      (second.body.tab as Record<string, unknown> | undefined)?.id ?? second.body.tabId ?? '',
    )
    expect(secondTabId).not.toEqual('')

    // A genuinely NEW tab, not a rejoin of the settled one.
    expect(secondTabId).not.toEqual(firstTabId)

    const { data: secondTab } = await admin
      .from('tabs')
      .select('id, status, tab_pin')
      .eq('id', secondTabId)
      .maybeSingle()
    expect(secondTab?.status).toBe('open')

    // No PIN challenge: the scanner CREATED this tab rather than being asked to join the
    // previous one. A 409 "Table already has an open tab", or a response demanding a PIN,
    // would both mean the clear did not actually free the table.
    expect(second.status).not.toBe(409)
    expect(JSON.stringify(second.body)).not.toMatch(/pin[_ ]?required.*true/i)
  }, 120000)

  test('CONTROL: without clearing, a second scan does NOT get a new tab', async () => {
    // Proves the test above is detecting the clear, not just "scanning always makes a tab".
    const a = await scan('e2e-control-session-a')
    const aTabId = String((a.body.tab as Record<string, unknown> | undefined)?.id ?? a.body.tabId ?? '')

    const b = await scan('e2e-control-session-b')
    const bTabId = String((b.body.tab as Record<string, unknown> | undefined)?.id ?? b.body.tabId ?? '')

    // Either the same tab is returned (join) or the second scan is refused — never a new tab.
    if (b.status < 400) {
      expect(bTabId).toEqual(aTabId)
    } else {
      expect(b.status).toBe(409)
    }
  }, 120000)
})
