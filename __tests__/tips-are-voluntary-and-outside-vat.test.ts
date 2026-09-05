/**
 * GRATUITIES ARE VOLUNTARY, OUTSIDE THE VAT BASE, AND OUTSIDE REVENUE.
 *
 * ============================================================================================
 * THE CONSTRAINT THESE ENFORCE
 * ============================================================================================
 *
 * A freely given gratuity is not consideration for the supply, so it sits outside the VAT base.
 * A COMPULSORY service charge is consideration: part of the price, taxable at the meal's rate,
 * and it belongs inside the order total. It must never be recorded as a tip.
 *
 * That distinction is only safe while it is STRUCTURAL. The moment `payment_tips` grows a
 * `mandatory` flag, or the tip starts flowing into `orders.total`, an untaxed compulsory charge
 * becomes representable and nobody finds out until an audit. These tests are the tripwire.
 *
 * Provenance: this follows the general consideration principle, not a NamRA ruling on gratuities
 * (none was found). A venue's accountant confirms the treatment. If that advice contradicts the
 * design, these tests should be changed deliberately -- which is the point of them being explicit.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseTipCents, recordTip, MAX_TIP_CENTS } from '@/lib/payments/tips'

const ROOT = join(__dirname, '..')
const MIGRATION = readFileSync(
  join(ROOT, 'supabase', 'migrations', '20260905120000_payment_tips.sql'),
  'utf8',
)
const MODULE_SRC = readFileSync(join(ROOT, 'lib', 'payments', 'tips.ts'), 'utf8')

/**
 * CODE WITH THE PROSE REMOVED.
 *
 * Asserting that a string is ABSENT breaks the moment the explanation mentions it — and here the
 * explanation must mention VAT, `updated_at` and `calculate-order-pricing`, because saying why
 * they are absent is the entire point of the comment. Without this, the tests would forbid the
 * documentation that makes the rule findable, which is exactly backwards. The same trap is
 * recorded in deploy-sequence-gates.test.ts for `--force`.
 */
const MIGRATION_CODE = MIGRATION.replace(/^\s*--.*$/gm, '')
const MODULE_CODE = MODULE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** The column list of the CREATE TABLE, which is where a forbidden field would actually appear. */
const TABLE_BODY = (() => {
  const m = MIGRATION_CODE.match(/CREATE TABLE[^(]*\(([\s\S]*?)\n\);/)
  if (!m) throw new Error('could not find the payment_tips CREATE TABLE body')
  return m[1]
})()

/** Records what was inserted, so the shape written is asserted rather than assumed. */
function supabaseDouble(result: { error?: { code?: string; message?: string } | null } = {}) {
  const inserted: Array<Record<string, unknown>> = []
  return {
    inserted,
    client: {
      from(table: string) {
        if (table !== 'payment_tips') throw new Error(`unexpected table ${table}`)
        return {
          insert(row: Record<string, unknown>) {
            inserted.push(row)
            return {
              select() {
                return {
                  single: async () =>
                    result.error
                      ? { data: null, error: result.error }
                      : { data: { id: 'tip-1' }, error: null },
                }
              },
            }
          },
        }
      },
    },
  }
}

const VALID = {
  restaurantId: 'rest-1',
  tipCents: 1250,
  method: 'card' as const,
  staffUserId: 'user-9',
  paymentReference: 'PR-123',
  paymentId: 'pay-1',
}

describe('a tip can never be made compulsory', () => {
  it('the table has no column that could mark one mandatory', () => {
    // A compulsory charge is taxable consideration. If it can be recorded here it escapes VAT.
    for (const forbidden of ['mandatory', 'compulsory', 'is_service_charge', 'service_charge', 'required']) {
      expect(TABLE_BODY.toLowerCase()).not.toMatch(new RegExp(`^\\s*${forbidden}\\s`, 'm'))
    }
  })

  it('the capture module exposes no flag, kind or toggle for it', () => {
    expect(MODULE_CODE).not.toMatch(/mandatory\s*[?:]/)
    expect(MODULE_CODE).not.toMatch(/isServiceCharge/)
    expect(MODULE_CODE).not.toMatch(/compulsory\s*[?:]/)
  })

  it('the migration states the rule and its provenance, so the next reader cannot miss it', () => {
    expect(MIGRATION).toMatch(/not consideration for the supply/i)
    expect(MIGRATION).toMatch(/COMPULSORY SERVICE CHARGE/i)
    expect(MIGRATION).toMatch(/order total/i)
    // Honest about what this is and is not based on.
    expect(MIGRATION).toMatch(/no NamRA guidance/i)
    expect(MIGRATION).toMatch(/accountant/i)
  })

  it('the capture module states the same rule where a developer will hit it', () => {
    expect(MODULE_SRC).toMatch(/not consideration for the supply/i)
    expect(MODULE_SRC).toMatch(/SEPARATE FEATURE/i)
    expect(MODULE_SRC).toMatch(/accountant/i)
  })
})

describe('a tip never enters the order total or the VAT base', () => {
  it('the capture module never touches orders or order pricing', () => {
    expect(MODULE_CODE).not.toMatch(/from\(['"]orders['"]\)/)
    expect(MODULE_CODE).not.toMatch(/calculate-order-pricing/)
    // ...while the prose says out loud that it must not, which is why the check strips comments.
    expect(MODULE_SRC).toMatch(/never passes through/i)
  })

  it('the migration adds no column to orders and no tax field of its own', () => {
    expect(MIGRATION_CODE).not.toMatch(/ALTER TABLE\s+(public\.)?orders/i)
    // A tax column ON THIS TABLE would mean a tip had acquired a VAT treatment of its own.
    expect(TABLE_BODY).not.toMatch(/^\s*\w*(vat|tax)\w*\s/im)
  })
})

describe('parsing a tip', () => {
  it('treats absent, null and empty as no tip rather than an error', () => {
    for (const v of [undefined, null, '']) {
      const r = parseTipCents(v)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.tipCents).toBe(0)
    }
  })

  it('accepts whole cents', () => {
    const r = parseTipCents(1250)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.tipCents).toBe(1250)
  })

  it('refuses a fractional amount, and says what to send instead', () => {
    const r = parseTipCents(12.5)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('TIP_NOT_AN_INTEGER')
      expect(r.message).toMatch(/1250 for NAD 12\.50/)
    }
  })

  it('refuses a negative tip — reversing one is a refund, not a negative gratuity', () => {
    const r = parseTipCents(-100)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('TIP_NEGATIVE')
  })

  it('REFUSES rather than clamps above the ceiling', () => {
    const r = parseTipCents(MAX_TIP_CENTS + 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('TIP_TOO_LARGE')
    // Clamping would take a different amount from the one the customer agreed to.
    expect(MODULE_SRC).toMatch(/It is a REFUSAL, not a clamp/)
  })

  it('refuses nonsense', () => {
    const r = parseTipCents('not a number')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('TIP_NOT_A_NUMBER')
  })
})

describe('recording a tip', () => {
  it('writes integer cents, the settler, and the settlement it rode on', async () => {
    const { client, inserted } = supabaseDouble()
    const r = await recordTip(client as never, { ...VALID, tabId: 'tab-7' })

    expect(r).toEqual({ recorded: true, id: 'tip-1' })
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toEqual({
      restaurant_id: 'rest-1',
      tip_cents: 1250,
      method: 'card',
      staff_user_id: 'user-9',
      payment_reference: 'PR-123',
      tab_id: 'tab-7',
      payment_id: 'pay-1',
      allocation_settlement_id: null,
    })
  })

  it('writes NO ROW for a zero tip', async () => {
    const { client, inserted } = supabaseDouble()
    const r = await recordTip(client as never, { ...VALID, tipCents: 0 })
    expect(r).toEqual({ recorded: false, reason: 'no_tip' })
    expect(inserted).toHaveLength(0)
  })

  it('refuses a tip that names no transaction', async () => {
    const { client, inserted } = supabaseDouble()
    const r = await recordTip(client as never, {
      ...VALID,
      paymentReference: '',
    })
    expect(r.recorded).toBe(false)
    if (!r.recorded && r.reason === 'failed') expect(r.error).toMatch(/transaction/)
    expect(inserted).toHaveLength(0)
  })

  it('refuses a tip with no staff member — money with no name is what this prevents', async () => {
    const { client } = supabaseDouble()
    const r = await recordTip(client as never, { ...VALID, staffUserId: '' })
    expect(r.recorded).toBe(false)
    if (!r.recorded && r.reason === 'failed') expect(r.error).toMatch(/staff member/)
  })

  it('treats a duplicate as already-recorded, not as a failure', async () => {
    const { client } = supabaseDouble({ error: { code: '23505', message: 'duplicate key' } })
    const r = await recordTip(client as never, VALID)
    expect(r).toEqual({ recorded: false, reason: 'duplicate' })
  })

  it('NEVER THROWS on a database error — the money has already moved', async () => {
    const { client } = supabaseDouble({ error: { code: '42501', message: 'permission denied' } })
    await expect(recordTip(client as never, VALID)).resolves.toEqual({
      recorded: false,
      reason: 'failed',
      error: 'permission denied',
    })
  })
})

describe('the ledger shape', () => {
  it('is append-only: no updated_at column, and integer cents not numeric', () => {
    expect(TABLE_BODY).not.toMatch(/^\s*updated_at\s/im)
    expect(MIGRATION_CODE).toMatch(/tip_cents integer NOT NULL CHECK \(tip_cents > 0\)/)
    expect(MIGRATION_CODE).not.toMatch(/tip_cents\s+numeric/)
  })

  it('requires a staff member and a settlement at the database level', () => {
    expect(MIGRATION).toMatch(/staff_user_id uuid NOT NULL/)
    expect(MIGRATION_CODE).toMatch(/payment_reference text NOT NULL/)
  })

  /**
   * THE WORD `UNIQUE` IS THE WHOLE GUARD, so it is what gets asserted.
   *
   * A first version of this test checked only that the index NAMES appeared. Mutation testing
   * caught it: downgrading `CREATE UNIQUE INDEX` to `CREATE INDEX` left the names untouched and
   * the suite green, while a retried settle could then record the same gratuity twice. Asserting
   * a name proves the line exists; it proves nothing about what the line does.
   */
  it('makes one-tip-per-settlement a database property, so a retry cannot double-count', () => {
    expect(MIGRATION_CODE).toMatch(/CREATE UNIQUE INDEX[^;]*payment_tips_one_per_transaction/)
    expect(MIGRATION_CODE).toMatch(/(restaurant_id, payment_reference)/)
    expect(MIGRATION_CODE).not.toMatch(/CREATE INDEX[^;]*payment_tips_one_per_/)
  })
})
