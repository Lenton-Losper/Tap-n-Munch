/**
 * Ad-hoc re-confirmation: terminal_printer_configs.connection_type CHECK constraint on
 * staging actually rejects an invalid value and actually accepts 'BUILTIN', via real
 * inserts (not just "the migration ran"). Cleans up after itself.
 *   npx tsx scripts/.confirm-builtin-check-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'

config({ path: '.env.test', override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const stagingUrl = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!stagingUrl?.includes(STAGING_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

const db = createClient(stagingUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `confirm-builtin-${Date.now()}`

async function main() {
  const { data: terminal, error: terminalError } = await db
    .from('restaurant_terminals')
    .insert({ restaurant_id: TEST_RESTAURANT_ID, device_id: `DEVICE-${tag}`, name: `${tag} terminal` })
    .select('id')
    .single()
  if (terminalError || !terminal) throw terminalError ?? new Error('terminal insert failed')

  console.log('--- Attempt 1: connection_type = FOOBAR (should be REJECTED) ---')
  const invalidResult = await db
    .from('terminal_printer_configs')
    .insert({
      terminal_id: terminal.id,
      connection_type: 'FOOBAR',
      printer_name: 'Invalid Test',
    })
    .select('*')
    .single()
  console.log(JSON.stringify({ data: invalidResult.data, error: invalidResult.error }, null, 2))

  console.log('\n--- Attempt 2: connection_type = BUILTIN (should SUCCEED) ---')
  const validResult = await db
    .from('terminal_printer_configs')
    .insert({
      terminal_id: terminal.id,
      connection_type: 'BUILTIN',
      printer_name: 'P5 Built-in Test',
      paper_width_mm: 58,
      character_width: 32,
    })
    .select('*')
    .single()
  console.log(JSON.stringify({ data: validResult.data, error: validResult.error }, null, 2))

  // Cleanup
  if (validResult.data?.id) {
    await db.from('terminal_printer_configs').delete().eq('id', validResult.data.id)
  }
  await db.from('restaurant_terminals').delete().eq('id', terminal.id)

  console.log('\n--- Post-cleanup verification ---')
  const { data: remaining } = await db
    .from('terminal_printer_configs')
    .select('id')
    .eq('terminal_id', terminal.id)
  const { data: remainingTerminal } = await db
    .from('restaurant_terminals')
    .select('id')
    .eq('id', terminal.id)
  console.log(JSON.stringify({ remainingPrinterConfigRows: remaining, remainingTerminalRows: remainingTerminal }, null, 2))

  const invalidRejected = invalidResult.error !== null && validResult.data !== null
  console.log(`\nCONFIRM_BUILTIN_CHECK_STAGING_${invalidRejected ? 'OK' : 'FAIL'}`)
  if (!invalidRejected) process.exit(1)
}

main().catch((error) => {
  console.error('CONFIRM_BUILTIN_CHECK_STAGING_ERROR', error)
  process.exit(1)
})
