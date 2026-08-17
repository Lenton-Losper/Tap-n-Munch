/**
 * `editAlreadyCommitted` — the #306 discriminator, and specifically its refusals.
 *
 * The staging probe proves the case that matters to a customer: a retry after a landed save is
 * told the truth. What it cannot easily reach is the set of cases where answering "yes" would be
 * a NEW false statement in the opposite direction — telling somebody their unsaved work landed.
 * Those are the ones worth pinning here, because each is a one-line mistake away.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { editAlreadyCommitted, EDIT_LOCK_TTL_MS } from '@/lib/orders/edit-lock'

/**
 * The columns the discriminator READS. Every one must be in the route's select lists, or it sees
 * `undefined`, conservatively returns false, and the fix is inert — which is exactly what
 * happened: `customer_edited_at` was written by the route and never selected by it, so the first
 * deploy of #306 typechecked, passed every unit test below, and changed nothing for a customer.
 * Only the staging probe caught it. This is the cheap guard that would have caught it sooner.
 */
const COLUMNS_THE_DISCRIMINATOR_READS = [
  'edit_lock_token',
  'customer_edit_count',
  'customer_edited_at',
]

const NOW = Date.parse('2026-08-17T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

/** A row whose lock was spent by a commit moments ago: token nulled, edit recorded. */
const committedRow = {
  edit_lock_token: null,
  customer_edit_count: 1,
  customer_edited_at: ago(5_000),
}

describe('the edit route selects what the discriminator reads', () => {
  const source = readFileSync(
    join(process.cwd(), 'app', 'api', 'guest', 'orders', '[orderId]', 'edit', 'route.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n')

  const listFor = (name: string) => {
    const m = source.match(new RegExp(`const ${name}\\s*=\\s*\\n?\\s*'([^']*)'`))
    expect(m).not.toBeNull() // a renamed constant must fail loudly, not silently pass
    return (m![1] ?? '').split(',').map((c) => c.trim())
  }

  it.each(['ORDER_COLUMNS', 'REQUEST_COLUMNS'])('%s selects every column it reads', (name) => {
    const columns = listFor(name)
    expect(columns.length).toBeGreaterThan(5)
    for (const needed of COLUMNS_THE_DISCRIMINATOR_READS) {
      expect(columns).toContain(needed)
    }
  })
})

describe('editAlreadyCommitted', () => {
  it('says yes when the caller’s own commit spent the lock', () => {
    expect(editAlreadyCommitted(committedRow, 'tok-1', NOW)).toBe(true)
  })

  it('says NO while a token is still sitting on the row', () => {
    // This is the whole discriminator: a commit NULLS the token, an expiry leaves it. Without
    // this clause an expired-but-unspent lock on a previously-edited order would be reported as
    // saved, which is the lie this fix exists to remove, pointing the other way.
    expect(
      editAlreadyCommitted({ ...committedRow, edit_lock_token: 'tok-1' }, 'tok-1', NOW),
    ).toBe(false)
  })

  it('says NO when the order was never edited', () => {
    expect(editAlreadyCommitted({ ...committedRow, customer_edit_count: 0 }, 'tok-1', NOW)).toBe(false)
    expect(editAlreadyCommitted({ ...committedRow, customer_edit_count: null }, 'tok-1', NOW)).toBe(false)
  })

  it('says NO when the edit is older than a lock could have lived', () => {
    // The presented token was issued at most one TTL ago or it would have expired by itself, so
    // an older edit cannot be the one that consumed it. A customer who saved, reopened, and let
    // the SECOND lock expire has unsaved work — telling them it saved would be the new lie.
    expect(
      editAlreadyCommitted({ ...committedRow, customer_edited_at: ago(EDIT_LOCK_TTL_MS + 1_000) }, 'tok-1', NOW),
    ).toBe(false)
    expect(
      editAlreadyCommitted({ ...committedRow, customer_edited_at: ago(EDIT_LOCK_TTL_MS - 1_000) }, 'tok-1', NOW),
    ).toBe(true)
  })

  it('says NO for a clock that ran backwards, rather than guessing', () => {
    expect(
      editAlreadyCommitted({ ...committedRow, customer_edited_at: new Date(NOW + 30_000).toISOString() }, 'tok-1', NOW),
    ).toBe(false)
  })

  it('says NO when no token was presented, or the timestamp is unusable', () => {
    expect(editAlreadyCommitted(committedRow, '', NOW)).toBe(false)
    expect(editAlreadyCommitted(committedRow, '   ', NOW)).toBe(false)
    expect(editAlreadyCommitted({ ...committedRow, customer_edited_at: null }, 'tok-1', NOW)).toBe(false)
    expect(editAlreadyCommitted({ ...committedRow, customer_edited_at: 'not a date' }, 'tok-1', NOW)).toBe(false)
  })
})
