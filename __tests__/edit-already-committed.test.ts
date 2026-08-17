/**
 * `editAlreadyCommitted` — the #306 discriminator, and specifically its refusals.
 *
 * The staging probe proves the case that matters to a customer: a retry after a landed save is
 * told the truth. What it cannot easily reach is the set of cases where answering "yes" would be
 * a NEW false statement in the opposite direction — telling somebody their unsaved work landed.
 * Those are the ones worth pinning here, because each is a one-line mistake away.
 */
import { editAlreadyCommitted, EDIT_LOCK_TTL_MS } from '@/lib/orders/edit-lock'

const NOW = Date.parse('2026-08-17T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

/** A row whose lock was spent by a commit moments ago: token nulled, edit recorded. */
const committedRow = {
  edit_lock_token: null,
  customer_edit_count: 1,
  customer_edited_at: ago(5_000),
}

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
