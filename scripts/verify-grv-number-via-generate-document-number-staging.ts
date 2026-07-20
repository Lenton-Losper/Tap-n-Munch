/**
 * Staging verification: goods_received still gets a correctly formatted GRV-###### number
 * after assign_grv_number() was changed to delegate to generate_document_number(), and the
 * sequence continues from its existing value rather than resetting.
 *   npx tsx scripts/verify-grv-number-via-generate-document-number-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'

config({ path: '.env.test', override: true })

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url?.includes(STAGING_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

const created = { goodsReceivedIds: [] as string[] }

async function cleanup() {
  if (created.goodsReceivedIds.length) {
    await db.from('goods_received').delete().in('id', created.goodsReceivedIds)
  }
}

async function main() {
  const { data: before, error: beforeError } = await db
    .from('goods_received')
    .select('grv_number')
    .not('grv_number', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
  if (beforeError) throw beforeError

  const priorNumber = before?.[0]?.grv_number as string | undefined
  const priorSequenceValue = priorNumber ? Number(priorNumber.replace('GRV-', '')) : 0

  const { data: inserted, error: insertError } = await db
    .from('goods_received')
    .insert({ restaurant_id: TEST_RESTAURANT_ID })
    .select('id, grv_number')
    .single()
  if (insertError || !inserted) throw insertError ?? new Error('insert failed')
  created.goodsReceivedIds.push(inserted.id)

  assert(
    /^GRV-\d{6}$/.test(inserted.grv_number),
    `grv_number should match GRV-###### format, got ${inserted.grv_number}`,
  )

  const newSequenceValue = Number(inserted.grv_number.replace('GRV-', ''))
  assert(
    newSequenceValue === priorSequenceValue + 1,
    `expected sequence to continue from ${priorSequenceValue} to ${priorSequenceValue + 1}, got ${newSequenceValue}`,
  )

  console.log('GRV_NUMBER_VIA_GENERATE_DOCUMENT_NUMBER_STAGING_VERIFY_OK', {
    priorNumber,
    newNumber: inserted.grv_number,
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('GRV_NUMBER_VIA_GENERATE_DOCUMENT_NUMBER_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
