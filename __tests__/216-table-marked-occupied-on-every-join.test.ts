/**
 * #216 — a table with a live tab and a non-'occupied' status is INVISIBLE to the payment terminal.
 *
 * `app/api/terminal/tables/route.ts` gates its entire list on `.eq('status','occupied')` joined
 * INNER against a live tab. So the failure is: a customer who wants to pay, and a device that
 * cannot see their table.
 *
 * WHAT THIS SUITE PINS is the WRITER, not the reader. #216's two listed fix directions both change
 * what the terminal reads; `__tests__/terminal-tables-gated-on-table-status.test.ts` (069b42d)
 * pins that coupling on purpose, and it is untouched. This pins the third option: make the column
 * true, so the invisible state stops being reachable.
 *
 * FAILS WITHOUT THE FIX. At `ceea943`:
 *   - `lib/tables/mark-table-occupied.ts` does not exist, so every case here errors at import;
 *   - `app/api/tabs/[tabId]/join/route.ts` contains zero occurrences of `restaurant_tables`;
 *   - `app/api/tabs/route.ts:373` is a bare `await supabase...update(...)` with no destructure.
 *
 * THE LOAD-BEARING CASE is "reports the failure instead of swallowing it". A PostgREST error
 * arrives in the RESOLVED object rather than as a throw, which is why the original bare `await`
 * could not fail loudly even in principle — the same shape that let #201's deleted Confirm Payment
 * handler run its success path unconditionally.
 */
import { markTableOccupied } from '@/lib/tables/mark-table-occupied'

const TABLE_ID = '77777777-2222-3333-4444-555555555555'

type Call = { table: string; patch: Record<string, unknown>; filters: Array<[string, unknown]> }

let calls: Call[]
let updateError: unknown

function fakeSupabase() {
  return {
    from(table: string) {
      return {
        update(patch: Record<string, unknown>) {
          const filters: Array<[string, unknown]> = []
          const chain = {
            eq(column: string, value: unknown) {
              filters.push([column, value])
              calls.push({ table, patch, filters })
              return Promise.resolve({ error: updateError })
            },
          }
          return chain
        },
      }
    },
  } as never
}

beforeEach(() => {
  calls = []
  updateError = null
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('#216 markTableOccupied', () => {
  it('writes status occupied, scoped to the one table by id', async () => {
    const result = await markTableOccupied(fakeSupabase(), TABLE_ID, '[test]')
    expect(result).toEqual({ ok: true, error: null, skipped: false })
    expect(calls).toEqual([
      { table: 'restaurant_tables', patch: { status: 'occupied' }, filters: [['id', TABLE_ID]] },
    ])
  })

  it('REPORTS the failure instead of swallowing it — the whole original defect', async () => {
    // A PostgREST error resolves; it does not throw. The bare `await` this replaces could never
    // have noticed.
    updateError = { code: '42501', message: 'permission denied' }
    const result = await markTableOccupied(fakeSupabase(), TABLE_ID, '[test]')
    expect(result.ok).toBe(false)
    expect(result.error).toEqual({ code: '42501', message: 'permission denied' })
    expect(result.skipped).toBe(false)
  })

  it('names the CONSEQUENCE in the log, not just the error', async () => {
    updateError = { message: 'boom' }
    const spy = console.error as jest.Mock
    await markTableOccupied(fakeSupabase(), TABLE_ID, '[TABS join]')
    const line = String(spy.mock.calls[0]?.[0] ?? '')
    expect(line).toContain('[TABS join]')
    expect(line).toContain('INVISIBLE ON THE PAYMENT TERMINAL')
    expect(line).toContain('#216')
  })

  it('skips a missing table id without writing and without claiming success', async () => {
    for (const missing of [null, undefined, '', '   ']) {
      calls = []
      const result = await markTableOccupied(fakeSupabase(), missing, '[test]')
      // A kiosk tab has no table. Not a failure, and emphatically not an `ok`.
      expect(result).toEqual({ ok: false, error: null, skipped: true })
      expect(calls).toEqual([])
    }
  })

  it('never writes any column other than status', async () => {
    await markTableOccupied(fakeSupabase(), TABLE_ID, '[test]')
    expect(Object.keys(calls[0].patch)).toEqual(['status'])
  })
})

/**
 * The three doors onto a live tab. Asserted on the SOURCE, because rendering these routes needs a
 * terminal auth stack and a Supabase client for a one-line question about which paths call the
 * helper. The risk of a source assertion is that it passes having found nothing — so every case
 * below first proves it is reading the right file.
 */
describe('#216 every path that puts a customer on a live tab marks the table', () => {
  const read = (p: string) => require('fs').readFileSync(require('path').join(process.cwd(), p), 'utf8')
  const CREATE = 'app/api/tabs/route.ts'
  const JOIN = 'app/api/tabs/[tabId]/join/route.ts'

  it('found both route files, so an empty scan cannot report green', () => {
    expect(read(CREATE)).toContain('issueTokenForOpenTab')
    expect(read(JOIN)).toContain('issueTokenForOpenTab')
  })

  it('the CREATE path calls the helper', () => {
    expect(read(CREATE)).toContain("markTableOccupied(supabase, tableRow.id, '[TABS create]')")
  })

  it('the 23505 RECOVERY-JOIN branch calls it — it returns before the create path ever runs', () => {
    expect(read(CREATE)).toContain("markTableOccupied(supabase, tableRow.id, '[TABS 23505-join]')")
  })

  it('the JOIN route calls it — it touched restaurant_tables zero times before', () => {
    expect(read(JOIN)).toContain("markTableOccupied(supabase, tableId, '[TABS join]')")
  })

  it('no bare unchecked update to restaurant_tables survives in either route', () => {
    for (const p of [CREATE, JOIN]) {
      const codeOnly = read(p)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      // The comments quote the old expression while explaining the fix; matching those proves
      // nothing, so they are stripped first.
      expect(codeOnly).not.toMatch(/from\('restaurant_tables'\)\s*\.update/)
    }
  })
})
