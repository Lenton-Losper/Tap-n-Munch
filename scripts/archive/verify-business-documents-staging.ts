/**
 * Staging verification: business_documents schema, sequences, RLS.
 *   npx tsx scripts/verify-business-documents-staging.ts
 */
import { execSync } from 'child_process'
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join, resolve } from 'path'
import { requireStagingTestPassword } from '../lib/staging/require-staging-test-password'

config({ path: resolve(__dirname, '../.env.test'), override: true })


const STAGING_TEST_PASSWORD = requireStagingTestPassword()

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const RESTAURANT_ID = 'a1999166-ddfa-40d1-ad1f-2f01282a1652'
const OWNER_EMAIL = 'flashtap.staging.test@gmail.com'
const OWNER_PASSWORD = STAGING_TEST_PASSWORD
const NON_PRIV_EMAIL = 'staging.kitchen.test@gmail.com'
const NON_PRIV_PASSWORD = STAGING_TEST_PASSWORD

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const ANON_KEY = process.env.SUPABASE_ANON_KEY || ''

if (!SUPABASE_URL.includes(STAGING_REF) || !SERVICE_KEY || !ANON_KEY) {
  throw new Error('Refusing: staging credentials missing (.env.test)')
}

const LINKED_PATH = join(__dirname, '../supabase/.temp/linked-project.json')
const MIGRATION_PATH = join(
  __dirname,
  '../supabase/migrations/20260705280000_business_documents.sql',
)

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

type ColRow = {
  table_name: string
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
}

let savedLinkedJson: string | null = null

function shell(command: string): string {
  return execSync(command, {
    cwd: join(__dirname, '..'),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh',
  })
}

function runLinkedSql(sql: string, label: string): string {
  const tmp = join(__dirname, `.verify-bd-${label}-${Date.now()}.sql`)
  writeFileSync(tmp, sql, 'utf8')
  const fileArg = tmp.replace(/\\/g, '/')
  try {
    return shell(
      `npx tsx scripts/safe-supabase-linked.ts ${STAGING_REF} db query --linked -f "${fileArg}"`,
    )
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

function ensureStagingLinked() {
  try {
    savedLinkedJson = readFileSync(LINKED_PATH, 'utf8')
  } catch {
    savedLinkedJson = null
  }
  const current = JSON.parse(savedLinkedJson || '{}') as { ref?: string }
  if (current.ref !== STAGING_REF) {
    console.log(`[setup] Linking Supabase CLI to staging (${STAGING_REF})...`)
    shell(`npx supabase link --project-ref ${STAGING_REF} --yes`)
  }
}

function restoreLinkedProject() {
  if (savedLinkedJson == null) return
  const current = JSON.parse(readFileSync(LINKED_PATH, 'utf8')) as { ref?: string }
  const saved = JSON.parse(savedLinkedJson) as { ref?: string }
  if (current.ref !== saved.ref) {
    writeFileSync(LINKED_PATH, savedLinkedJson, 'utf8')
    console.log(`[cleanup] Restored linked project ref to ${saved.ref}`)
  }
}

async function ensureMigrationApplied() {
  const probe = await admin.from('restaurant_billing_profiles').select('id').limit(1)
  if (!probe.error) return
  const msg = String(probe.error.message || '')
  const code = String(probe.error.code || '')
  const missing =
    code === '42P01' ||
    code === 'PGRST205' ||
    msg.includes('does not exist') ||
    msg.includes('schema cache')
  if (!missing) throw probe.error
  console.log('[setup] Tables missing — applying migration via safe-supabase-linked...')
  const mig = MIGRATION_PATH.replace(/\\/g, '/')
  shell(`npx tsx scripts/safe-supabase-linked.ts ${STAGING_REF} db query --linked -f "${mig}"`)
}

function parseJsonRows(stdout: string): ColRow[] {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as {
      rows?: ColRow[]
    }
    return parsed.rows ?? []
  } catch {
    return []
  }
}

async function signIn(email: string, password: string) {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error || !data.session) throw new Error(`Sign-in failed for ${email}: ${error?.message}`)
  return client
}

async function cleanup(restaurantId: string) {
  await admin.from('business_documents').delete().eq('restaurant_id', restaurantId)
  await admin.from('restaurant_billing_profiles').delete().eq('restaurant_id', restaurantId)
  await admin.from('document_sequences').delete().eq('restaurant_id', restaurantId)
}

async function main() {
  ensureStagingLinked()
  const results: Record<string, unknown> = {}

  try {
    await ensureMigrationApplied()

    // --- Check 1: live schema ---
    const schemaOut = runLinkedSql(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('restaurant_billing_profiles', 'document_sequences', 'business_documents')
ORDER BY table_name, ordinal_position;`,
      'schema',
    )
    const cols = parseJsonRows(schemaOut)
    const byTable = {
      restaurant_billing_profiles: cols.filter((c) => c.table_name === 'restaurant_billing_profiles'),
      document_sequences: cols.filter((c) => c.table_name === 'document_sequences'),
      business_documents: cols.filter((c) => c.table_name === 'business_documents'),
    }
    results.check1_schema = {
      pass:
        byTable.restaurant_billing_profiles.length > 0 &&
        byTable.document_sequences.length > 0 &&
        byTable.business_documents.length > 0,
      columns: byTable,
      rawCliOutput: schemaOut.trim(),
    }

    await cleanup(RESTAURANT_ID)

    // --- Check 2: get_next_document_number ---
    const seq2: Record<string, unknown> = {}
    const { data: inv1, error: inv1Err } = await admin.rpc('get_next_document_number', {
      p_restaurant_id: RESTAURANT_ID,
      p_document_type: 'invoice',
    })
    const { data: inv2, error: inv2Err } = await admin.rpc('get_next_document_number', {
      p_restaurant_id: RESTAURANT_ID,
      p_document_type: 'invoice',
    })
    const { data: quote1, error: quote1Err } = await admin.rpc('get_next_document_number', {
      p_restaurant_id: RESTAURANT_ID,
      p_document_type: 'quote',
    })

    seq2.sequential = {
      invoice_first: inv1,
      invoice_second: inv2,
      quote_first: quote1,
      errors: [inv1Err, inv2Err, quote1Err].filter(Boolean),
      pass: inv1 === 1 && inv2 === 2 && quote1 === 1,
    }

    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () =>
        admin.rpc('get_next_document_number', {
          p_restaurant_id: RESTAURANT_ID,
          p_document_type: 'invoice',
        }),
      ),
    )
    const concurrentNums = concurrent.map((r) => r.data as number)
    const sorted = [...concurrentNums].sort((a, b) => a - b)
    const unique = new Set(concurrentNums)
    const expected = [3, 4, 5, 6, 7]
    seq2.concurrent = {
      values: concurrentNums,
      sorted,
      uniqueCount: unique.size,
      expected,
      pass:
        unique.size === 5 &&
        sorted.every((n, i) => n === expected[i]) &&
        concurrent.every((r) => !r.error),
      errors: concurrent.map((r) => r.error?.message).filter(Boolean),
    }
    results.check2_sequences = {
      pass: Boolean((seq2.sequential as { pass: boolean }).pass && (seq2.concurrent as { pass: boolean }).pass),
      details: seq2,
    }

    // --- Check 3: set_document_sequence_start ---
    await admin.from('document_sequences').delete().eq('restaurant_id', RESTAURANT_ID)

    const setFresh = await admin.rpc('set_document_sequence_start', {
      p_restaurant_id: RESTAURANT_ID,
      p_document_type: 'quote',
      p_start_at: 2502,
    })
    const afterSet = await admin.rpc('get_next_document_number', {
      p_restaurant_id: RESTAURANT_ID,
      p_document_type: 'quote',
    })

    const backward = await admin.rpc('set_document_sequence_start', {
      p_restaurant_id: RESTAURANT_ID,
      p_document_type: 'quote',
      p_start_at: 5,
    })

    results.check3_set_start = {
      pass:
        !setFresh.error &&
        afterSet.data === 2502 &&
        Boolean(backward.error) &&
        String(backward.error?.message || '').toLowerCase().includes('backward'),
      setFreshError: setFresh.error?.message ?? null,
      nextAfterSet: afterSet.data,
      backwardError: backward.error?.message ?? null,
    }

    // Seed rows for RLS check
    const { data: restaurantRow, error: restaurantErr } = await admin
      .from('restaurants')
      .select('owner_id')
      .eq('id', RESTAURANT_ID)
      .single()
    if (restaurantErr || !restaurantRow?.owner_id) {
      throw new Error(`Owner user not found for test restaurant: ${restaurantErr?.message}`)
    }
    const ownerUserId = String(restaurantRow.owner_id)

    await admin.from('restaurant_billing_profiles').upsert({
      restaurant_id: RESTAURANT_ID,
      registration_number: 'VERIFY-REG',
      vat_number: 'VERIFY-VAT',
    })
    await admin.from('business_documents').insert({
      restaurant_id: RESTAURANT_ID,
      document_type: 'invoice',
      document_number: 'VERIFY-INV-000001',
      ship_to: { name: 'Test', email: '', organization: '', phone: '', customFields: {} },
      bill_to: { name: 'Test', email: '', organization: '', phone: '', customFields: {} },
      line_items: [{ description: 'Item', quantity: 1, unit_price: 10, line_total: 10 }],
      subtotal: 10,
      vat_amount: 0,
      total: 10,
      balance: 10,
      created_by: ownerUserId,
    })

    const ownerClient = await signIn(OWNER_EMAIL, OWNER_PASSWORD)
    const kitchenClient = await signIn(NON_PRIV_EMAIL, NON_PRIV_PASSWORD)

    const ownerBilling = await ownerClient
      .from('restaurant_billing_profiles')
      .select('id,registration_number')
      .eq('restaurant_id', RESTAURANT_ID)
    const ownerDocs = await ownerClient
      .from('business_documents')
      .select('id,document_number')
      .eq('restaurant_id', RESTAURANT_ID)

    const kitchenBilling = await kitchenClient
      .from('restaurant_billing_profiles')
      .select('id')
      .eq('restaurant_id', RESTAURANT_ID)
    const kitchenDocs = await kitchenClient
      .from('business_documents')
      .select('id')
      .eq('restaurant_id', RESTAURANT_ID)

    results.check4_rls = {
      pass:
        (ownerBilling.data?.length ?? 0) >= 1 &&
        (ownerDocs.data?.length ?? 0) >= 1 &&
        (kitchenBilling.data?.length ?? 0) === 0 &&
        (kitchenDocs.data?.length ?? 0) === 0 &&
        !kitchenBilling.error &&
        !kitchenDocs.error,
      owner: {
        billingCount: ownerBilling.data?.length ?? 0,
        docsCount: ownerDocs.data?.length ?? 0,
        billingError: ownerBilling.error?.message ?? null,
        docsError: ownerDocs.error?.message ?? null,
      },
      nonOwnerKitchen: {
        email: NON_PRIV_EMAIL,
        billingCount: kitchenBilling.data?.length ?? 0,
        docsCount: kitchenDocs.data?.length ?? 0,
        billingError: kitchenBilling.error?.message ?? null,
        docsError: kitchenDocs.error?.message ?? null,
      },
    }

    console.log(JSON.stringify(results, null, 2))

    const allPass = Object.entries(results).every(([, v]) => {
      if (v && typeof v === 'object' && 'pass' in (v as object)) return Boolean((v as { pass: boolean }).pass)
      return true
    })
    if (!allPass) {
      console.error('BUSINESS_DOCUMENTS_STAGING_FAIL')
      process.exitCode = 1
    } else {
      console.log('BUSINESS_DOCUMENTS_STAGING_OK')
    }
  } finally {
    await cleanup(RESTAURANT_ID)
    restoreLinkedProject()
  }
}

main().catch((err) => {
  console.error(err)
  restoreLinkedProject()
  process.exitCode = 1
})
