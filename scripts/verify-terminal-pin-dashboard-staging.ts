/**
 * Staging verification for the Terminal PIN Management Dashboard (issue #27).
 *
 *   VERIFY_APP_URL=http://localhost:3100 npx tsx scripts/verify-terminal-pin-dashboard-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { resolve } from 'path'
import { verifyTerminalPin } from '../lib/terminal-auth/pin-credentials'

config({ path: resolve(__dirname, '../.env.test'), override: true })

const APP = process.env.VERIFY_APP_URL || 'http://localhost:3100'
const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const OWNER_EMAIL = 'flashtap.staging.test@gmail.com'
const OWNER_PASSWORD = process.env.STAGING_TEST_PASSWORD || ''
const TARGET_USER_ID = 'e65059f8-0727-4c9f-a268-4661eadb0325' // staging.kitchen.test@gmail.com

const url = process.env.SUPABASE_URL || ''
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const anonKey = process.env.SUPABASE_ANON_KEY || ''

if (!url.includes(STAGING_REF) || !serviceKey || !anonKey) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}
if (!OWNER_PASSWORD) {
  throw new Error('Refusing: STAGING_TEST_PASSWORD missing from .env.test')
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

function record(id: string, pass: boolean, detail: string) {
  console.log(`${pass ? 'PASS' : 'FAIL'} [${id}] ${detail}`)
  if (!pass) throw new Error(`Failed: ${id}`)
}

async function pinRequest(
  method: 'GET' | 'POST' | 'DELETE',
  token: string,
  body?: Record<string, unknown>,
) {
  const res = await fetch(`${APP}/api/admin/restaurants/${RESTAURANT_ID}/terminal-auth/pin`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

async function main() {
  console.log('=== Terminal PIN Dashboard staging verification (#27) ===')

  // Sign in as the real staging owner to get a real user access token.
  const anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: signIn, error: signInError } = await anon.auth.signInWithPassword({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
  })
  if (signInError || !signIn.session) throw new Error(`Owner sign-in failed: ${signInError?.message}`)
  const ownerToken = signIn.session.access_token
  record('0-owner-signin', true, `signed in as ${OWNER_EMAIL}`)

  // Clean slate: ensure no pre-existing credential for the target user.
  await admin.from('terminal_authorization_credentials').delete().eq('user_id', TARGET_USER_ID).eq('restaurant_id', RESTAURANT_ID)

  // 1. GET status list -- target user should show not_set, no pin fields present anywhere.
  const before = await pinRequest('GET', ownerToken)
  const rawBefore = JSON.stringify(before.json)
  const targetBefore = (before.json.staff ?? []).find((s: any) => s.user_id === TARGET_USER_ID)
  record(
    '1-status-not-set',
    before.status === 200 && targetBefore?.pin_status === 'not_set',
    `status=${before.status} pin_status=${targetBefore?.pin_status}`,
  )
  record(
    '1-no-pin-value-in-response',
    !rawBefore.includes('pin_hash') && !rawBefore.includes('pin_salt') && !/"pin"\s*:/.test(rawBefore),
    'response contains no pin_hash/pin_salt/pin fields',
  )

  // 2. Set a PIN for the target user as owner.
  const NEW_PIN = '4271'
  const setResult = await pinRequest('POST', ownerToken, { target_user_id: TARGET_USER_ID, pin: NEW_PIN })
  record('2-set-pin-success', setResult.status === 200 && setResult.json.success === true, `status=${setResult.status} body=${JSON.stringify(setResult.json)}`)
  record('2-set-response-has-no-pin-value', !JSON.stringify(setResult.json).match(/pin_hash|pin_salt|"pin"/), 'set response has no pin material')

  // 3. Confirm hashed, not plaintext, in the DB directly.
  const { data: credRow } = await admin
    .from('terminal_authorization_credentials')
    .select('pin_hash, pin_salt')
    .eq('user_id', TARGET_USER_ID)
    .eq('restaurant_id', RESTAURANT_ID)
    .maybeSingle()
  record(
    '3-hashed-not-plaintext',
    !!credRow?.pin_hash && !!credRow?.pin_salt && credRow.pin_hash !== NEW_PIN,
    `pin_hash present=${!!credRow?.pin_hash} pin_salt present=${!!credRow?.pin_salt} equals-plaintext=${credRow?.pin_hash === NEW_PIN}`,
  )

  // 4. Confirm the stored hash actually verifies against the real PIN via the same
  //    verifyTerminalPin() the terminal's own PIN-auth flow (app/api/terminal/authorize) uses --
  //    strong evidence the terminal app CAN authorize with it, without needing physical device access.
  const verifiesCorrect = await verifyTerminalPin(NEW_PIN, credRow!.pin_hash, credRow!.pin_salt)
  const verifiesWrong = await verifyTerminalPin('0000', credRow!.pin_hash, credRow!.pin_salt)
  record(
    '4-verifies-via-terminal-auth-verifyTerminalPin',
    verifiesCorrect === true && verifiesWrong === false,
    `correct-pin-verifies=${verifiesCorrect} wrong-pin-rejected=${!verifiesWrong}`,
  )

  // 5. GET status again -- now 'set'.
  const afterSet = await pinRequest('GET', ownerToken)
  const targetAfterSet = (afterSet.json.staff ?? []).find((s: any) => s.user_id === TARGET_USER_ID)
  record('5-status-set', targetAfterSet?.pin_status === 'set' && !!targetAfterSet?.pin_updated_at, `pin_status=${targetAfterSet?.pin_status}`)

  // 6. Audit trail: credential_set event recorded, actor = owner, target = kitchen user, no PIN value.
  const { data: setEvent } = await admin
    .from('authorization_events')
    .select('event_type, actor_user_id, restaurant_id, detail, created_at')
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('event_type', 'credential_set')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  record(
    '6-audit-credential-set',
    setEvent?.detail?.target_user_id === TARGET_USER_ID && !JSON.stringify(setEvent).includes(NEW_PIN),
    `detail=${JSON.stringify(setEvent?.detail)} actor=${setEvent?.actor_user_id}`,
  )

  // 7. Token invalidation: seed an outstanding (unused) token for the target user, then
  //    change the PIN and confirm the outstanding token row is gone.
  const { data: terminalRow } = await admin.from('restaurant_terminals').select('id').eq('restaurant_id', RESTAURANT_ID).limit(1).maybeSingle()
  const { data: tokenRow, error: tokenInsertError } = await admin
    .from('privileged_authorization_tokens')
    .insert({
      user_id: TARGET_USER_ID,
      restaurant_id: RESTAURANT_ID,
      terminal_id: terminalRow!.id,
      purpose: 'refund',
      nonce: `pin-dash-verify-${Date.now()}`,
      ttl_seconds: 90,
      expires_at: new Date(Date.now() + 90_000).toISOString(),
    })
    .select('id')
    .single()
  if (tokenInsertError) throw tokenInsertError
  record('7-seed-outstanding-token', !!tokenRow?.id, `seeded token id=${tokenRow?.id}`)

  const CHANGED_PIN = '9630'
  const changeResult = await pinRequest('POST', ownerToken, { target_user_id: TARGET_USER_ID, pin: CHANGED_PIN })
  record('7-change-pin-success', changeResult.status === 200, `status=${changeResult.status}`)

  const { data: tokenAfterChange } = await admin
    .from('privileged_authorization_tokens')
    .select('id')
    .eq('id', tokenRow!.id)
    .maybeSingle()
  record('7-outstanding-token-invalidated', !tokenAfterChange, `token row after PIN change: ${JSON.stringify(tokenAfterChange)}`)

  const { data: resetEvent } = await admin
    .from('authorization_events')
    .select('detail')
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('event_type', 'credential_reset')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  record(
    '7-audit-invalidated-count-logged',
    resetEvent?.detail?.invalidated_token_count === 1,
    `invalidated_token_count=${resetEvent?.detail?.invalidated_token_count}`,
  )

  // 8. Revoke the PIN entirely.
  const revokeResult = await pinRequest('DELETE', ownerToken, { target_user_id: TARGET_USER_ID })
  record('8-revoke-success', revokeResult.status === 200 && revokeResult.json.success === true, `status=${revokeResult.status} body=${JSON.stringify(revokeResult.json)}`)

  const { data: credRowAfterRevoke } = await admin
    .from('terminal_authorization_credentials')
    .select('user_id')
    .eq('user_id', TARGET_USER_ID)
    .eq('restaurant_id', RESTAURANT_ID)
    .maybeSingle()
  record('8-credential-row-gone', !credRowAfterRevoke, 'terminal_authorization_credentials row deleted')

  const afterRevoke = await pinRequest('GET', ownerToken)
  const targetAfterRevoke = (afterRevoke.json.staff ?? []).find((s: any) => s.user_id === TARGET_USER_ID)
  record('8-status-not-set-again', targetAfterRevoke?.pin_status === 'not_set', `pin_status=${targetAfterRevoke?.pin_status}`)

  const { data: revokeEvent } = await admin
    .from('authorization_events')
    .select('detail, actor_user_id')
    .eq('restaurant_id', RESTAURANT_ID)
    .eq('event_type', 'credential_revoked')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  record(
    '8-audit-credential-revoked',
    revokeEvent?.detail?.target_user_id === TARGET_USER_ID,
    `detail=${JSON.stringify(revokeEvent?.detail)}`,
  )

  console.log('\nTERMINAL_PIN_DASHBOARD_STAGING_OK')
}

main()
  .catch((err) => {
    console.error('FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await admin.from('terminal_authorization_credentials').delete().eq('user_id', TARGET_USER_ID).eq('restaurant_id', RESTAURANT_ID)
    await admin.from('privileged_authorization_tokens').delete().eq('user_id', TARGET_USER_ID).eq('restaurant_id', RESTAURANT_ID)
    console.log('cleanup complete')
  })
