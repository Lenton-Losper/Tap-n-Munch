/**
 * Staging verification: POST /api/terminal/printer-config now stores whatever
 * connection_type the terminal actually sends, instead of hardcoding 'BLUETOOTH'.
 * Hits the real DEPLOYED route over HTTP (not an in-process call, not a direct DB
 * insert), with a real signed terminal JWT, then confirms both the DB row and a
 * subsequent GET reflect 'BUILTIN' -- not silently coerced back to 'BLUETOOTH'.
 *   npx tsx scripts/verify-terminal-printer-config-connection-type-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { signTerminalJwt } from '../lib/terminals/terminal-jwt'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'

config({ path: '.env.test', override: true })
config({ path: '.env.local', override: false })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const stagingUrl = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const APP_URL = 'https://flashtap-staging.llosperofficial.workers.dev'

if (!stagingUrl?.includes(STAGING_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

const db = createClient(stagingUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `conn-type-${Date.now()}`

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

async function main() {
  const { data: terminal, error: terminalError } = await db
    .from('restaurant_terminals')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      device_id: `DEVICE-${tag}`,
      device_serial: `SERIAL-${tag}`,
      name: `${tag} terminal`,
      status: 'active',
    })
    .select('id, device_serial')
    .single()
  if (terminalError || !terminal) throw terminalError ?? new Error('terminal insert failed')

  const jwt = await signTerminalJwt({
    terminal_id: terminal.id,
    restaurant_id: TEST_RESTAURANT_ID,
    device_serial: terminal.device_serial,
  })

  try {
    // --- POST with connection_type: 'BUILTIN' against the real deployed route ---
    console.log('--- POST connection_type=BUILTIN ---')
    const postRes = await fetch(`${APP_URL}/api/terminal/printer-config`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connection_type: 'BUILTIN',
        printer_name: 'P5 Built-in',
        printer_address: 'BUILTIN',
        paper_width_mm: 58,
        character_width: 32,
      }),
    })
    const postBody = (await postRes.json()) as { config?: { id: string; connection_type: string } }
    console.log('status:', postRes.status, 'body:', JSON.stringify(postBody))
    assert(postRes.status === 200, `POST should return 200, got ${postRes.status}`)
    assert(postBody.config?.connection_type === 'BUILTIN', `response config.connection_type should be BUILTIN, got ${postBody.config?.connection_type}`)

    // --- Ground truth: the DB row itself, via an independent service-role query ---
    const { data: dbRow, error: dbRowError } = await db
      .from('terminal_printer_configs')
      .select('id, connection_type, printer_name')
      .eq('terminal_id', terminal.id)
      .single()
    if (dbRowError || !dbRow) throw dbRowError ?? new Error('printer config row not found in DB')
    console.log('DB row (ground truth):', JSON.stringify(dbRow))
    assert(dbRow.connection_type === 'BUILTIN', `DB row connection_type should be BUILTIN, got ${dbRow.connection_type} (not silently coerced to BLUETOOTH)`)
    assert(dbRow.id === postBody.config!.id, 'DB row id should match the id returned by POST')

    // --- GET through the real deployed route: does it come back correctly? ---
    console.log('\n--- GET ---')
    const getRes = await fetch(`${APP_URL}/api/terminal/printer-config`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    const getBody = (await getRes.json()) as { config?: { connection_type: string; printer_name: string } }
    console.log('status:', getRes.status, 'body:', JSON.stringify(getBody))
    assert(getRes.status === 200, `GET should return 200, got ${getRes.status}`)
    assert(getBody.config?.connection_type === 'BUILTIN', `GET response connection_type should be BUILTIN, got ${getBody.config?.connection_type}`)

    // --- Regression check: omitting connection_type still defaults to BLUETOOTH ---
    console.log('\n--- POST with no connection_type (should default to BLUETOOTH) ---')
    const { data: terminal2, error: terminal2Error } = await db
      .from('restaurant_terminals')
      .insert({
        restaurant_id: TEST_RESTAURANT_ID,
        device_id: `DEVICE-${tag}-2`,
        device_serial: `SERIAL-${tag}-2`,
        name: `${tag}-2 terminal`,
        status: 'active',
      })
      .select('id, device_serial')
      .single()
    if (terminal2Error || !terminal2) throw terminal2Error ?? new Error('second terminal insert failed')

    const jwt2 = await signTerminalJwt({
      terminal_id: terminal2.id,
      restaurant_id: TEST_RESTAURANT_ID,
      device_serial: terminal2.device_serial,
    })

    try {
      const defaultRes = await fetch(`${APP_URL}/api/terminal/printer-config`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ printer_name: 'TP80N', printer_address: '00:11:22:33:44:CC', paper_width_mm: 80 }),
      })
      const defaultBody = (await defaultRes.json()) as { config?: { connection_type: string } }
      console.log('status:', defaultRes.status, 'body:', JSON.stringify(defaultBody))
      assert(defaultBody.config?.connection_type === 'BLUETOOTH', `omitted connection_type should default to BLUETOOTH, got ${defaultBody.config?.connection_type}`)

      // --- Rejects an invalid connection_type ---
      const invalidRes = await fetch(`${APP_URL}/api/terminal/printer-config`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt2}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_type: 'FOOBAR', printer_name: 'X', printer_address: 'Y' }),
      })
      console.log('\n--- POST with connection_type=FOOBAR (should be rejected) ---')
      console.log('status:', invalidRes.status)
      assert(invalidRes.status === 400, `invalid connection_type should be rejected with 400, got ${invalidRes.status}`)

      console.log('\nTERMINAL_PRINTER_CONFIG_CONNECTION_TYPE_STAGING_VERIFY_OK', {
        terminalId: terminal.id,
        printerConfigId: postBody.config!.id,
      })
    } finally {
      await db.from('terminal_printer_configs').delete().eq('terminal_id', terminal2.id)
      await db.from('restaurant_terminals').delete().eq('id', terminal2.id)
    }
  } finally {
    await db.from('terminal_printer_configs').delete().eq('terminal_id', terminal.id)
    await db.from('restaurant_terminals').delete().eq('id', terminal.id)
  }
}

main().catch((error) => {
  console.error('TERMINAL_PRINTER_CONFIG_CONNECTION_TYPE_STAGING_VERIFY_FAIL', error)
  process.exit(1)
})
