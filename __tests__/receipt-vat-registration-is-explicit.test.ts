/**
 * VAT registration is a merchant's explicit answer, and a receipt records the answer that was
 * true when it was issued — including "nobody had answered".
 *
 * ============================================================================================
 * THE AMBIGUITY THIS CLOSES
 * ============================================================================================
 *
 * `restaurant_billing_profiles.vat_number` is nullable and, before migration 20260901120000,
 * there was no registration flag. A NULL therefore meant two different things with nothing to
 * separate them: "this merchant is not VAT registered" and "nobody has filled this in".
 *
 * Measured read-only on production 2026-09-01:
 *
 *     billing profiles                   0    (for 11 venues)
 *     receipts                       2,514
 *     receipts that CHARGED VAT      1,241    Mingle 664, FNB ChowNow 554, Riviera 22
 *     receipts carrying a VAT number     0
 *
 * So 1,241 receipts state a VAT amount with no registration number, and until now the system had
 * no way to say whether that is a compliance gap or the correct output for an unregistered
 * merchant.
 *
 * ============================================================================================
 * THE RULE THESE TESTS DEFEND
 * ============================================================================================
 *
 * Absence is never converted into an answer. Not into "registered", and — the tempting one —
 * not into "not registered" either. Calling those 1,241 receipts "not registered" would assert on
 * a tax document that VAT was charged by a business that is not VAT registered, which is a claim
 * nobody made and which may be false.
 *
 * Historical receipts are NOT backfilled. A receipt from July cannot acquire a VAT number that
 * did not exist when it was issued.
 */
import {
  receiptVatRegistration,
  receiptVatConcern,
  issueReceiptForOrder,
  type ReceiptSnapshot,
} from '@/lib/receipts/issueReceipt'
import { InMemoryDb, testUuid } from './helpers/in-memory-postgrest'

// ── the tri-state reader ─────────────────────────────────────────────────────

function snapshot(outlet: Partial<ReceiptSnapshot['outlet']>, vat = 0): ReceiptSnapshot {
  return {
    renderer_version: 'receipt-render-v2',
    outlet: {
      restaurant_name: 'Venue',
      address: null,
      vat_number: null,
      registration_number: null,
      currency: 'NAD',
      ...outlet,
    },
    customer_name: null,
    table_number: null,
    channel: null,
    staff_name: null,
    line_items: [],
    totals: { subtotal: 100 - vat, vat, discount: 0, grand_total: 100 },
    payments: [],
  }
}

describe('reading the registration off a receipt', () => {
  it('an explicit yes reads as registered', () => {
    expect(receiptVatRegistration(snapshot({ vat_registered: true, vat_number: 'VAT-1' }))).toBe(
      'registered',
    )
  })

  it('an explicit no reads as not registered', () => {
    expect(receiptVatRegistration(snapshot({ vat_registered: false }))).toBe('not_registered')
  })

  /** The one that matters: every historical receipt is in this state. */
  it('an ABSENT field reads as unknown — never as "not registered"', () => {
    const historical = snapshot({})
    delete (historical.outlet as { vat_registered?: boolean | null }).vat_registered
    expect(receiptVatRegistration(historical)).toBe('unknown')
    expect(receiptVatRegistration(historical)).not.toBe('not_registered')
  })

  it('an explicit null also reads as unknown', () => {
    expect(receiptVatRegistration(snapshot({ vat_registered: null }))).toBe('unknown')
  })

  it('is not fooled by a truthy non-boolean', () => {
    const odd = snapshot({})
    ;(odd.outlet as Record<string, unknown>).vat_registered = 'yes'
    expect(receiptVatRegistration(odd)).toBe('unknown')
  })
})

describe('reporting a tax contradiction without rewriting it', () => {
  it('says nothing when no VAT was charged', () => {
    expect(receiptVatConcern(snapshot({ vat_registered: false }, 0))).toBeNull()
    expect(receiptVatConcern(snapshot({}, 0))).toBeNull()
  })

  it('flags VAT charged by a merchant recorded as NOT registered', () => {
    expect(receiptVatConcern(snapshot({ vat_registered: false }, 15))).toMatch(/not VAT registered/)
  })

  it('flags the 1,241 production receipts: VAT charged, no answer recorded', () => {
    const historical = snapshot({}, 15)
    delete (historical.outlet as { vat_registered?: boolean | null }).vat_registered
    expect(receiptVatConcern(historical)).toMatch(/no VAT registration answer was recorded/)
  })

  it('flags a registered merchant whose number was not frozen', () => {
    expect(receiptVatConcern(snapshot({ vat_registered: true }, 15))).toMatch(/no VAT number was frozen/)
  })

  it('is silent on a correctly formed VAT receipt', () => {
    expect(receiptVatConcern(snapshot({ vat_registered: true, vat_number: 'VAT-123' }, 15))).toBeNull()
  })
})

// ── issuance freezes the answer, and survives a database that cannot hold it ──

const RESTAURANT = testUuid('rest')
const ORDER = testUuid('ord')
const dbRef = { current: new InMemoryDb() }

jest.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => dbRef.current.client(),
}))

function seed(billingRow: Record<string, unknown> | null) {
  dbRef.current = new InMemoryDb(
    {
      restaurants: [{ id: RESTAURANT, name: 'Mingle Brew & Pour', address: 'Windhoek', currency: 'NAD' }],
      restaurant_billing_profiles: billingRow ? [{ restaurant_id: RESTAURANT, ...billingRow }] : [],
      orders: [
        {
          id: ORDER,
          restaurant_id: RESTAURANT,
          payment_status: 'paid',
          payment_method: 'card',
          payment_reference: 'REF-4321',
          paid_at: '2026-09-01T10:00:00Z',
          subtotal: 87,
          tax: 13,
          total: 100,
          items: [{ menu_item_id: testUuid('mi'), name: 'Flat white', quantity: 1, subtotal: 87, tax: 13, total: 100 }],
          table_number: 3,
          channel: 'table',
          customer_name: null,
          order_instructions: null,
        },
      ],
      payment_events: [],
      receipt_documents: [],
    },
    {
      receipt_documents: {
        defaults: { version: 1, status: 'issued', document_type: 'SALE_RECEIPT', issued_at: '2026-09-01T10:00:05Z' },
        unique: [['order_id', 'document_type', 'version']],
      },
    },
  )
}

describe('issuance freezes the merchant answer', () => {
  it('a registered merchant freezes true and the number', async () => {
    seed({ vat_number: 'VAT-99887', registration_number: 'CC/2026/1', vat_registered: true })
    const receipt = await issueReceiptForOrder(ORDER)
    expect(receipt.snapshot_json.outlet.vat_registered).toBe(true)
    expect(receipt.snapshot_json.outlet.vat_number).toBe('VAT-99887')
    expect(receiptVatConcern(receipt.snapshot_json)).toBeNull()
  })

  it('an explicitly unregistered merchant freezes false and no number', async () => {
    seed({ vat_number: null, registration_number: 'CC/2026/2', vat_registered: false })
    const receipt = await issueReceiptForOrder(ORDER)
    expect(receipt.snapshot_json.outlet.vat_registered).toBe(false)
    expect(receipt.snapshot_json.outlet.vat_number).toBeNull()
    expect(receiptVatRegistration(receipt.snapshot_json)).toBe('not_registered')
  })

  it('NO billing profile at all freezes unknown, not false', async () => {
    seed(null)
    const receipt = await issueReceiptForOrder(ORDER)
    expect(receipt.snapshot_json.outlet.vat_registered).toBeNull()
    expect(receiptVatRegistration(receipt.snapshot_json)).toBe('unknown')
  })

  /**
   * THE DEPLOY-ORDER SAFETY PROPERTY.
   *
   * `vat_registered` arrives with migration 20260901120000, and this code can reach a database
   * that has not had it applied. The registration read is deliberately a SEPARATE query for this
   * reason: folded into the main billing select — whose error is discarded, so that a missing
   * profile does not fail issuance — an absent column would return a null ROW and silently strip
   * the VAT number and registration number from every receipt issued.
   *
   * Simulated here by failing exactly the `vat_registered` select.
   */
  it('an UNMIGRATED database costs only the new field, never the VAT number', async () => {
    seed({ vat_number: 'VAT-99887', registration_number: 'CC/2026/1' })
    const real = dbRef.current.client()
    const patched = {
      ...real,
      from(table: string) {
        const builder = real.from(table)
        if (table !== 'restaurant_billing_profiles') return builder
        const originalSelect = builder.select.bind(builder)
        return {
          ...builder,
          select(cols?: string) {
            if (typeof cols === 'string' && cols.includes('vat_registered')) {
              return {
                eq: () => ({
                  maybeSingle: async () => ({
                    data: null,
                    error: { code: '42703', message: 'column "vat_registered" does not exist' },
                  }),
                }),
              }
            }
            return originalSelect(cols)
          },
        }
      },
    }
    const spy = jest
      .spyOn(dbRef.current, 'client')
      .mockReturnValue(patched as ReturnType<InMemoryDb['client']>)

    const receipt = await issueReceiptForOrder(ORDER)

    // The new field degrades to "unknown"…
    expect(receipt.snapshot_json.outlet.vat_registered).toBeNull()
    // …and the facts that already worked are untouched. This is the assertion that matters.
    expect(receipt.snapshot_json.outlet.vat_number).toBe('VAT-99887')
    expect(receipt.snapshot_json.outlet.registration_number).toBe('CC/2026/1')
    expect(receipt.snapshot_json.totals.grand_total).toBe(100)

    spy.mockRestore()
  })
})

// ── the migration says what it does ──────────────────────────────────────────

describe('the migration is safe to apply', () => {
  const sql = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'supabase', 'migrations', '20260901120000_billing_profile_vat_registration.sql'),
    'utf8',
  ) as string

  /**
   * Assert on the STATEMENTS, not the file. The first draft matched the docblock — which
   * explains at length why `DEFAULT false` would be wrong and what an inline CHECK does — and
   * failed on its own explanation. A check that reads prose is not checking the migration.
   */
  const statements = sql
    .split(String.fromCharCode(10))
    .filter((line) => !line.trimStart().startsWith('--'))
    .join(String.fromCharCode(10))

  it('the comment stripper leaves the real SQL and removes the prose', () => {
    expect(statements).toMatch(/ALTER TABLE public\.restaurant_billing_profiles/)
    expect(statements).not.toMatch(/THE PROBLEM THIS SOLVES/)
  })

  it('adds a NULLABLE column — it does not assert an answer for anyone', () => {
    expect(statements).toMatch(/ADD COLUMN IF NOT EXISTS vat_registered boolean/)
    expect(statements).not.toMatch(/vat_registered boolean[^;]*NOT NULL/)
    expect(statements).not.toMatch(/DEFAULT\s+(true|false)/)
  })

  it('backfills nothing', () => {
    expect(sql).not.toMatch(/\bUPDATE\s+public\.restaurant_billing_profiles/i)
    expect(sql).not.toMatch(/\bINSERT\s+INTO/i)
  })

  /** #212: an inline CHECK on ADD COLUMN IF NOT EXISTS is silently skipped when the column exists. */
  it('adds the CHECK as its own statement, not inline on the ADD COLUMN', () => {
    const addColumn = statements.slice(statements.indexOf('ADD COLUMN IF NOT EXISTS'))
    const firstStatement = addColumn.slice(0, addColumn.indexOf(';'))
    expect(firstStatement).not.toMatch(/CHECK/i)
    expect(statements).toMatch(/ADD CONSTRAINT restaurant_billing_profiles_vat_number_required_when_registered/)
    expect(statements).toMatch(/DROP CONSTRAINT IF EXISTS restaurant_billing_profiles_vat_number_required_when_registered/)
  })

  it('makes a VAT number mandatory only when the merchant claims registration', () => {
    expect(statements).toMatch(/vat_registered IS NOT TRUE/)
    expect(statements).toMatch(/length\(btrim\(vat_number\)\) > 0/)
  })
})
