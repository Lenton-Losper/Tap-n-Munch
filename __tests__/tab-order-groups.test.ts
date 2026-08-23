/**
 * Binds to lib/tabs/tab-order-groups.ts — the shared Tab's grouping.
 *
 * The three tests that are the point, in order of how much they would cost if they regressed:
 *
 *   1. `never attributes an unresolvable order to anybody` — the human's standing ruling is
 *      "never infer a financial relationship; a missing link is a finding, not a case to handle".
 *      An implementation that filed a stray order under the caller, or under the first member,
 *      would make the screen add up while being wrong about whose bill it is.
 *   2. `a paid order stays visible but stops being owed` — spec section 29's partially settled
 *      tab. Dropping it hides that somebody paid; counting it double-bills the table.
 *   3. `payable and pending are never summed into one figure` — the two-figure ruling, per person.
 */
import { buildTabOrderGroups } from '@/lib/tabs/tab-order-groups'
import { owesMoney } from '@/lib/payments/payment-integrity'
import { isSettlementArtefact } from '@/lib/tabs/tab-outstanding'

const MEMBERS = [
  { member_key: 'mk_lenton', display_name: 'Lenton' },
  { member_key: 'mk_bob', display_name: 'Bob' },
]

function order(over: Record<string, unknown> = {}) {
  return {
    id: 'o1',
    status: 'accepted',
    order_number: 41,
    total: 95,
    payment_status: 'pending',
    member_session_id: 'mk_lenton',
    items: [{ name: 'Beef Burger', quantity: 1, subtotal: 95 }],
    ...over,
  }
}

function request(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    status: 'waiting_review',
    total: 20,
    subtotal: 20,
    tax: 0,
    member_session_id: 'mk_bob',
    items: [{ name: 'Sprite', quantity: 1, subtotal: 20 }],
    ...over,
  }
}

function build(over: Partial<Parameters<typeof buildTabOrderGroups>[0]> = {}) {
  return buildTabOrderGroups({
    members: MEMBERS,
    selfMemberKeys: ['mk_lenton'],
    orders: [order()],
    requests: [request()],
    owesMoney,
    isSettlementArtefact: (row) => isSettlementArtefact(row as never),
    ...over,
  })
}

describe('buildTabOrderGroups — the shared table', () => {
  it('groups each order under the diner who placed it', () => {
    const { members } = build()
    const lenton = members.find((m) => m.member_key === 'mk_lenton')
    const bob = members.find((m) => m.member_key === 'mk_bob')

    expect(lenton?.display_name).toBe('Lenton')
    expect(lenton?.orders.map((o) => o.lines[0].name)).toEqual(['Beef Burger'])
    expect(bob?.display_name).toBe('Bob')
    expect(bob?.orders.map((o) => o.lines[0].name)).toEqual(['Sprite'])
  })

  it('marks only the caller as self, and that is a rendering hint not a permission', () => {
    const { members } = build()
    expect(members.find((m) => m.member_key === 'mk_lenton')?.is_self).toBe(true)
    expect(members.find((m) => m.member_key === 'mk_bob')?.is_self).toBe(false)
  })

  it('drops members who have ordered nothing', () => {
    const { members } = build({ requests: [] })
    expect(members.map((m) => m.member_key)).toEqual(['mk_lenton'])
  })
})

describe('buildTabOrderGroups — the two figures, per person', () => {
  it('payable and pending are never summed into one figure', () => {
    const { members } = build()
    const lenton = members.find((m) => m.member_key === 'mk_lenton')!
    const bob = members.find((m) => m.member_key === 'mk_bob')!

    expect(lenton.payable).toBe(95)
    expect(lenton.pending).toBe(0)
    // Bob has submitted N$20 and the restaurant has not answered: it is NOT owed yet.
    expect(bob.payable).toBe(0)
    expect(bob.pending).toBe(20)
  })

  it('a paid order stays visible but stops being owed', () => {
    const { members } = build({
      orders: [order({ payment_status: 'paid' })],
      requests: [],
    })
    const lenton = members.find((m) => m.member_key === 'mk_lenton')!

    // Spec section 29: a partially settled tab must still read as one bill.
    expect(lenton.orders).toHaveLength(1)
    expect(lenton.payable).toBe(0)
  })

  it('excludes a settlement artefact from both the list and the figures', () => {
    const { members } = build({
      orders: [order(), order({ id: 'o2', total: 500, tab_settlement_for_tab_id: 'tab-1' })],
      requests: [],
    })
    const lenton = members.find((m) => m.member_key === 'mk_lenton')!
    expect(lenton.orders.map((o) => o.id)).toEqual(['o1'])
    expect(lenton.payable).toBe(95)
  })

  it('prices a pending request by precedence, not by its raw total', () => {
    // reviewed ?? customer ?? original. A staff review has moved the price; the customer must be
    // shown the figure that would actually be charged, not the one they submitted.
    const { members } = build({
      orders: [],
      requests: [request({ items_reviewed: [{ name: 'Sprite', quantity: 1, subtotal: 25 }], total_reviewed: 25 })],
    })
    const bob = members.find((m) => m.member_key === 'mk_bob')!
    expect(bob.pending).toBe(25)
    expect(bob.orders[0].total).toBe(25)
  })
})

describe('buildTabOrderGroups — never infer a financial relationship', () => {
  it('never attributes an unresolvable order to anybody', () => {
    const { members, unattributed } = build({
      orders: [order(), order({ id: 'o-stray', member_session_id: '', session_id: '', total: 60 })],
      requests: [],
    })

    // Not folded into the caller, not into the first member, and not dropped.
    expect(members.find((m) => m.member_key === 'mk_lenton')!.payable).toBe(95)
    expect(unattributed.orders.map((o) => o.id)).toEqual(['o-stray'])
    expect(unattributed.payable).toBe(60)
    expect(unattributed.display_name).toBe('')
  })

  it('gives an order from a key with no member row its own group rather than calling it unattributed', () => {
    // It IS attributed -- to someone who left the members array or ordered before joining.
    // Calling that "unattributed" would lose the fact that those lines belong together.
    const { members, unattributed } = build({
      orders: [order({ id: 'o-ghost', member_session_id: 'mk_sarah', total: 78 })],
      requests: [],
    })
    const sarah = members.find((m) => m.member_key === 'mk_sarah')
    expect(sarah?.payable).toBe(78)
    expect(sarah?.is_self).toBe(false)
    expect(unattributed.orders).toHaveLength(0)
  })

  it('reports no unattributed orders in the ordinary case', () => {
    expect(build().unattributed.orders).toHaveLength(0)
  })
})

describe('buildTabOrderGroups — what a diner may see about another diner', () => {
  it('emits no session id, no member session id and no edit lock token', () => {
    const { members } = build({
      orders: [order({ session_id: 'session_secret', edit_lock_token: 'tok_secret' })],
      requests: [],
    })
    const serialised = JSON.stringify(members)
    expect(serialised).not.toContain('session_secret')
    expect(serialised).not.toContain('tok_secret')
    expect(serialised).not.toContain('edit_lock')
  })

  it('distinguishes a request from an order, so the screen can say which is which', () => {
    const { members } = build()
    const lenton = members.find((m) => m.member_key === 'mk_lenton')!
    const bob = members.find((m) => m.member_key === 'mk_bob')!

    expect(lenton.orders[0].surface).toBe('orders')
    expect(lenton.orders[0].is_pending).toBe(false)
    expect(lenton.orders[0].order_number).toBe(41)

    expect(bob.orders[0].surface).toBe('order_requests')
    expect(bob.orders[0].is_pending).toBe(true)
    // No number is allocated until Accept, so there is nothing honest to print.
    expect(bob.orders[0].order_number).toBeNull()
  })
})

/**
 * #293 — the line figure is what the customer PAYS.
 *
 * The click test found "Beef Burger x1 - NAD82.61" with "NAD95.00 awaiting confirmation" printed
 * directly beneath it, and N$95 on the menu. 82.61 is the ex-VAT base at the 15% inclusive rate;
 * it is not a price anybody is ever charged.
 *
 * The fixture above never caught it because its items carry `subtotal` and no `total`, so the two
 * figures coincide. These use the REAL stored shape, taken from a staging row:
 *
 *   { subtotal: 21.74, tax: 3.26, total: 25, taxInclusive: true, taxRatePercentage: 15 }
 */
describe('#293 line prices are tax-inclusive and sum to the order total', () => {
  const REAL_BURGER = {
    name: 'Beef Burger',
    quantity: 1,
    subtotal: 82.61,
    tax: 12.39,
    total: 95,
    taxInclusive: true,
    taxRatePercentage: 15,
  }
  const REAL_CHICKEN = {
    name: 'Chicken burger',
    quantity: 1,
    subtotal: 21.74,
    tax: 3.26,
    total: 25,
    taxInclusive: true,
    taxRatePercentage: 15,
  }

  it('shows the inclusive figure, not the ex-VAT base', () => {
    const groups = build({ orders: [order({ items: [REAL_BURGER], total: 95 })], requests: [] })
    const line = groups.members.flatMap((g) => g.orders).flatMap((o) => o.lines)[0]
    expect(line.total).toBe(95)
    // The exact number a customer was shown. If this ever comes back, it comes back loudly.
    expect(line.total).not.toBe(82.61)
  })

  it('the lines SUM to the total printed beneath them', () => {
    const groups = build({
      orders: [order({ items: [REAL_BURGER, REAL_CHICKEN], total: 120 })],
      requests: [],
    })
    const orderOut = groups.members.flatMap((g) => g.orders)[0]
    const sum = orderOut.lines.reduce((n, l) => n + l.total, 0)
    expect(sum).toBe(120)
    expect(sum).toBe(orderOut.total)
  })

  it('an exclusive-rate line also shows what is charged', () => {
    // For an exclusive rate the customer pays subtotal + tax, which is `total` again. Reading
    // `subtotal` was wrong for BOTH tax modes, not only the inclusive one.
    const exclusive = { name: 'Water', quantity: 1, subtotal: 20, tax: 3, total: 23, taxInclusive: false }
    const groups = build({ orders: [order({ items: [exclusive], total: 23 })], requests: [] })
    expect(groups.members.flatMap((g) => g.orders)[0].lines[0].total).toBe(23)
  })

  it('an old row with no per-line total is reconstructed, not read as its ex-VAT base', () => {
    // The fallback that matters: falling straight back to `subtotal` would have left exactly the
    // oldest orders showing the wrong figure.
    const legacy = { name: 'Old Item', quantity: 1, subtotal: 82.61, tax: 12.39 }
    const groups = build({ orders: [order({ items: [legacy], total: 95 })], requests: [] })
    expect(groups.members.flatMap((g) => g.orders)[0].lines[0].total).toBe(95)
  })

  it('a row with neither total nor tax falls back to the subtotal rather than to zero', () => {
    const ancient = { name: 'Ancient', quantity: 1, subtotal: 40 }
    const groups = build({ orders: [order({ items: [ancient], total: 40 })], requests: [] })
    expect(groups.members.flatMap((g) => g.orders)[0].lines[0].total).toBe(40)
  })
})
