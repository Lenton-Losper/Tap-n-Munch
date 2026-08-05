/**
 * READ-ONLY probe of PRODUCTION for objects created by 20260705210000_post_payment_order_lifecycle
 * and 20260705220000_refund_events.
 *
 * The CLI is linked to staging and re-linking to production needs a DB password we do not hold,
 * so pg_policies / pg_indexes / pg_constraint / pg_trigger are NOT reachable. This probes what
 * PostgREST can prove and prints what it could not check.
 *
 * EVERY probe method is calibrated against a live control first, because the naive versions of
 * both probes give false MISSINGs:
 *   - a bogus-argument RPC returns "Could not find the function ... in the schema cache" even
 *     when the function exists under a different signature, and
 *   - a table absent from the PostgREST schema cache is indistinguishable from one that does not
 *     exist unless you have seen what each error actually looks like.
 * Performs no writes.
 */
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
if (!url.includes('ihlmmpmolnpchzgwyhgh')) {
  throw new Error(`REFUSING: expected production ref ihlmmpmolnpchzgwyhgh, got ${url}`)
}
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY || '', {
  auth: { persistSession: false, autoRefreshToken: false },
})

/**
 * Table existence. Deliberately NOT `select('*', { head: true, count: 'exact' })`: on this
 * project that form returns NO error and a null count for a table that does not exist, so it
 * reports every absent table as present. Verified with a live control. Selecting a named column
 * without `head` surfaces a real PGRST205, so that is what is used.
 */
async function tableProbe(t: string) {
  const { error, count } = await db.from(t).select('*', { count: 'exact' }).limit(1)
  return { code: error?.code ?? 'ok', msg: (error?.message ?? '').slice(0, 60), count }
}

async function columnProbe(t: string, c: string) {
  const { error } = await db.from(t).select(c).limit(1)
  return { code: error?.code ?? 'ok', msg: (error?.message ?? '').slice(0, 60) }
}

async function main() {
  console.log('=== CONTROLS — calibrate the probes before trusting any result ===\n')

  const cKnownTable = await tableProbe('orders')
  const cFakeTable = await tableProbe('definitely_not_a_real_table_xyz')
  console.log(`control table PRESENT (orders):      code=${cKnownTable.code} count=${cKnownTable.count}`)
  console.log(`control table ABSENT  (fake):        code=${cFakeTable.code} ${cFakeTable.msg}`)

  const cKnownCol = await columnProbe('orders', 'id')
  const cFakeCol = await columnProbe('orders', 'definitely_not_a_column_xyz')
  console.log(`control column PRESENT (orders.id):  code=${cKnownCol.code}`)
  console.log(`control column ABSENT  (fake):       code=${cFakeCol.code} ${cFakeCol.msg}`)

  if (cKnownTable.code !== 'ok' || cFakeTable.code === 'ok' || cKnownCol.code !== 'ok' || cFakeCol.code === 'ok') {
    console.log('\nCONTROLS FAILED — probe method is not sound here. Not reporting results.')
    return
  }
  console.log('\nControls behave as required: present=ok, absent=error code.\n')

  console.log('=== TABLES AND COLUMNS ON PRODUCTION ===\n')
  const TABLE_COLUMNS: Record<string, string[]> = {
    document_sequences: ['restaurant_id', 'sequence_type', 'current_number'],
    invoice_requests: [
      'id', 'restaurant_id', 'order_id', 'payment_id', 'idempotency_key', 'invoice_number',
      'status', 'company_name', 'vat_number', 'email', 'metadata', 'pdf_url', 'failure_reason',
      'retry_count', 'requested_at', 'generated_at', 'sent_at', 'created_at', 'updated_at',
    ],
    order_revisions: [
      'id', 'restaurant_id', 'order_id', 'revision_number', 'amended_by', 'reason', 'changes',
      'financial_delta', 'created_at',
    ],
    refund_events: [
      'id', 'restaurant_id', 'order_id', 'payment_id', 'amount', 'reason', 'refunded_by',
      'idempotency_key', 'status', 'created_at',
    ],
  }

  for (const [table, cols] of Object.entries(TABLE_COLUMNS)) {
    const t = await tableProbe(table)
    if (t.code !== 'ok') {
      console.log(`TABLE ${table}: MISSING  [${t.code}] ${t.msg}`)
      continue
    }
    const missing: string[] = []
    for (const c of cols) {
      const r = await columnProbe(table, c)
      if (r.code !== 'ok') missing.push(`${c}[${r.code}]`)
    }
    console.log(
      `TABLE ${table}: present (count=${t.count}); ${cols.length} columns -> ` +
        (missing.length ? `${missing.length} MISSING: ${missing.join(', ')}` : 'ALL PRESENT'),
    )
  }

  console.log('\n=== restaurants.short_code ===')
  const sc = await columnProbe('restaurants', 'short_code')
  console.log(`restaurants.short_code: ${sc.code === 'ok' ? 'present' : `MISSING [${sc.code}] ${sc.msg}`}`)
  if (sc.code === 'ok') {
    const { data } = await db.from('restaurants').select('name, short_code')
    for (const r of data ?? []) {
      const row = r as Record<string, unknown>
      console.log(`   ${String(row.name).padEnd(26)} short_code=${row.short_code ?? '(null)'}`)
    }
  }

  console.log(
    '\n=== NOT CHECKABLE from here (needs catalog access / DB password) ===\n' +
      '  indexes, RLS policies, named constraints, triggers, rowsecurity flags, CHECK\n' +
      '  constraints, and function existence (a bogus-arg RPC cannot distinguish "absent"\n' +
      '  from "exists with a different signature", so no function result is reported).',
  )
}

main().catch((e) => { console.error('THREW:', e?.message ?? e); process.exit(1) })
