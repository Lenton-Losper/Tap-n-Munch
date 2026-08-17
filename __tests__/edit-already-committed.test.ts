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
 * THE CLASS, not this one discriminator: *a route reads a field it never selected, typechecks,
 * and is inert.*
 *
 * `customer_edited_at` was written by the edit route and never selected by it, so the first
 * deploy of #306 passed `tsc` (the row is `Record<string, unknown>`), passed every unit test
 * below (they hand the function a row directly and cannot see the select list), deployed, served,
 * and changed nothing for a customer. Only the staging probe caught it.
 *
 * So this scans the edit path for every field read off the loaded row and checks each against the
 * route's own select constants, rather than pinning the three columns that happened to bite.
 */
const ROW_READERS = [
  ['app/api/guest/orders/[orderId]/edit/route.ts', 'route'],
  ['lib/orders/edit-lock.ts', 'edit-lock'],
  ['lib/orders/order-request-pricing.ts', 'pricing'],
] as const

/**
 * Fields only one surface has, read only behind a surface check. MEASURED on 2026-08-17, not
 * assumed — each entry was traced to the guard that keeps it off the other surface:
 *
 *   payment_status, payment_checkout_url   read by `editRefusalReason`, called only when
 *                                          surface === 'orders'. `requestEditRefusalReason` was
 *                                          read and touches neither.
 *   *_customer, *_reviewed                 read by `effectiveRequestPricing`, reached only via
 *                                          `effectiveOf`'s order_requests branch; plus
 *                                          `staffReviewDiscarded`, gated on the same surface.
 *
 * An entry here is a claim that a read is surface-guarded. Adding one without tracing the guard
 * is how this test stops meaning anything.
 */
const SURFACE_ONLY: Record<string, 'orders' | 'order_requests'> = {
  payment_status: 'orders',
  payment_checkout_url: 'orders',
  items_customer: 'order_requests',
  subtotal_customer: 'order_requests',
  tax_customer: 'order_requests',
  total_customer: 'order_requests',
  items_reviewed: 'order_requests',
  subtotal_reviewed: 'order_requests',
  tax_reviewed: 'order_requests',
  total_reviewed: 'order_requests',
}

/** Property accesses on a row-shaped variable that are not database columns. */
const NOT_A_COLUMN = new Set([
  'length', 'map', 'filter', 'find', 'some', 'every', 'push', 'reduce', 'slice',
  'toString', 'trim', 'includes', 'sort', 'join', 'split', 'concat',
])

const NOW = Date.parse('2026-08-17T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

/** A row whose lock was spent by a commit moments ago: token nulled, edit recorded. */
const committedRow = {
  edit_lock_token: null,
  customer_edit_count: 1,
  customer_edited_at: ago(5_000),
}

describe('the edit path never reads a column it did not select', () => {
  const codeOnly = (s: string) =>
    s.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const src = (rel: string) => codeOnly(readFileSync(join(process.cwd(), ...rel.split('/')), 'utf8'))

  const route = src('app/api/guest/orders/[orderId]/edit/route.ts')
  const listFor = (name: string) => {
    const m = route.match(new RegExp(`const ${name}\\s*=\\s*\\n?\\s*'([^']*)'`))
    expect(m).not.toBeNull() // a renamed constant must fail loudly, not silently pass
    return (m![1] ?? '').split(',').map((c) => c.trim())
  }
  const ORDER = listFor('ORDER_COLUMNS')
  const REQUEST = listFor('REQUEST_COLUMNS')

  /** Every field read off the loaded DB row, with where it was read. */
  const readFields = new Map<string, Set<string>>()
  for (const [rel, label] of ROW_READERS) {
    const s = src(rel)
    for (const pattern of [/\btarget\.row\.(\w+)/g, /\bfresh\.row\.(\w+)/g, /\brow\??\.(\w+)/g]) {
      for (const m of s.matchAll(pattern)) {
        if (NOT_A_COLUMN.has(m[1])) continue
        if (!readFields.has(m[1])) readFields.set(m[1], new Set())
        readFields.get(m[1])!.add(label)
      }
    }
  }

  it('found the constants and a real set of reads', () => {
    expect(ORDER.length).toBeGreaterThan(10)
    expect(REQUEST.length).toBeGreaterThan(10)
    expect(readFields.size).toBeGreaterThan(10)
    // The field that caused this whole guard to exist must be among the reads it examines.
    expect(readFields.has('customer_edited_at')).toBe(true)
  })

  it('every field read is selected by the surface that can reach it', () => {
    const inert: string[] = []
    for (const [field, where] of readFields) {
      const only = SURFACE_ONLY[field]
      const needsOrder = only !== 'order_requests'
      const needsRequest = only !== 'orders'
      if (needsOrder && !ORDER.includes(field)) inert.push(`${field} (ORDER_COLUMNS) read in ${[...where].join(', ')}`)
      if (needsRequest && !REQUEST.includes(field)) inert.push(`${field} (REQUEST_COLUMNS) read in ${[...where].join(', ')}`)
    }
    if (inert.length) {
      throw new Error(
        'These fields are read but never selected, so they arrive as undefined:\n  ' +
          inert.join('\n  ') +
          '\n\nAdd them to the select list, or -- if the read is behind a surface check -- add ' +
          'them to SURFACE_ONLY and record which guard keeps them off the other surface. ' +
          'Do not add an entry without tracing the guard.',
      )
    }
    expect(inert).toEqual([])
  })

  it('has no SURFACE_ONLY entry for a field nothing reads any more', () => {
    // A stale claim rots into decoration, and decoration is how the check above starts passing
    // for the wrong reason.
    expect(Object.keys(SURFACE_ONLY).filter((f) => !readFields.has(f)).sort()).toEqual([])
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
