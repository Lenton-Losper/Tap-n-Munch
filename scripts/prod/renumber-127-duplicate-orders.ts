/**
 * #127 — THE FOUR REAL DUPLICATE ORDER NUMBERS. Production. WRITES. One-off.
 *
 * NOT RUN. Prepared and dry-run-only until the owner authorises it. It changes `order_number` on
 * four PAID, COMPLETED orders, which is customer financial history, not cleanup.
 *
 * ============================================================================================
 * WHAT IS WRONG, MEASURED ON PRODUCTION 2026-08-26
 * ============================================================================================
 *
 * Four (restaurant_id, order_number) pairs are held by two orders each. All four are FNB ChowNow,
 * all four came through the POS, and every pair was written inside half a second:
 *
 *   #314   2026-07-23  N$40  + N$40    407 ms apart   RCT-000226 / RCT-000225
 *   #420   2026-07-24  N$34  + N$78    187 ms apart   RCT-000308 / RCT-000310
 *   #448   2026-07-24  N$26  + N$46    247 ms apart   RCT-000345 / RCT-000344
 *   #1158  2026-08-24  N$143 + N$125   347 ms apart   RCT-001514 / (none — cancelled)
 *
 * Each row carries its own receipt document and, for six of the eight, its own payment_event with
 * its own gateway reference and its own amount. They are eight separate sales, not four sales
 * recorded twice. `CREATE UNIQUE INDEX` cannot be created while any of them stands.
 *
 * ============================================================================================
 * THE REMEDY: RENUMBER THE LOSER INTO THE GAP THE COLLISION ITSELF LEFT
 * ============================================================================================
 *
 * FNB ChowNow's numbering has exactly four gaps, and they are 315, 421, 449 and 1159 — one
 * immediately after each duplicated number, and nothing else is missing anywhere in 1..1465.
 *
 * That is the mechanism visible in the data. Before a collision the venue holds N-1 orders with
 * max N-1. Two writers both read N-1 and both write N. Now the count is N+1 while the max is only
 * N, so the next order is issued N+2 and N+1 is never used by anybody.
 *
 * So the gap is the number the losing write SHOULD have received, it is free, and it is adjacent.
 * Moving the later row of each pair into it is the smallest possible edit.
 *
 * AND IT IS THE ONLY SAFE TARGET, WHICH IS THE PART THAT IS EASY TO MISS. Renumbering to a fresh
 * high number instead — 1466, 1467… — leaves the count unchanged while raising the max, so
 * `count(*) + 1` immediately returns a number that is already taken. With the new unique index in
 * place that is a 23505 on the venue's next order, and on every order after it, because count(*)
 * does not change. Filling the gaps keeps count and max equal (1465 = 1465), which is the
 * invariant the old allocator depends on. After all four, FNB ChowNow holds 1465 orders numbered
 * 1..1465 with no gaps and no repeats.
 *
 * The allocator in lib/orders/order-number.ts no longer depends on that invariant. This script
 * preserves it anyway, so the repair is safe in whichever order the two are deployed.
 *
 * ============================================================================================
 * WHICH ROW OF EACH PAIR MOVES, AND WHAT IT COSTS
 * ============================================================================================
 *
 * THE LATER `placed_at`. It is the write that lost the race and whose number was already taken
 * when it was issued; the earlier row's number is the one that was correct at the time it was
 * given out, shown on a screen and spoken aloud.
 *
 * WHAT DOES NOT BREAK, verified rather than assumed:
 *
 *   - No receipt is invalidated. NONE of production's 1804 receipt_documents stores an order
 *     number anywhere in its snapshot — checked with a recursive jsonb path over every row, not
 *     by reading the renderer. A receipt is identified by its RCT number and that does not move.
 *   - No other table stores an order number. `order_number` exists on exactly one table.
 *     `payment_events.business_order_no` and `held_payments.business_order_no` are gateway
 *     references derived from the order UUID, not from this number.
 *   - No foreign key references it. The two FKs into `orders` are on `id`
 *     (order_requests.accepted_order_id, receipt_documents.order_id), and `id` does not change.
 *
 * WHAT DOES CHANGE: what the dashboard, the kitchen list and any report show for that order, and
 * therefore any paper or verbal reference to "order 420" made at the time. The orders are one to
 * five weeks old and all four are closed out. That cost is real but small, and it is the reason
 * this needs a human rather than a migration.
 *
 * ============================================================================================
 * IT RE-DERIVES EVERY PRECONDITION AND REFUSES IF ANY TRIPS
 * ============================================================================================
 *
 * It takes no arguments naming an order, accepts no count, and cannot be told to skip a check.
 * The four pairs are FOUND, not listed — a hard-coded id list would still be applied faithfully
 * after the underlying data had moved.
 *
 * Usage:
 *   node node_modules/tsx/dist/cli.mjs scripts/prod/renumber-127-duplicate-orders.ts            # dry run
 *   node node_modules/tsx/dist/cli.mjs scripts/prod/renumber-127-duplicate-orders.ts --confirm  # apply
 */
import { guard, all } from './_guard'

/** More than this many duplicate groups means the population is not the one described above. */
const MAX_GROUPS = 8

type OrderRow = {
  id: string
  restaurant_id: string | null
  firebase_restaurant_id: string | null
  order_number: number | null
  total: number | null
  status: string | null
  payment_status: string | null
  placed_at: string | null
}

async function main() {
  const { db, confirmed } = guard(
    [
      'Renumbers the LATER order of each duplicated (restaurant_id, order_number) pair into',
      'the adjacent free number, so a unique index can be created.',
      '',
      'It finds the pairs itself, re-derives every precondition, and REFUSES if any trips.',
      'Four orders are expected to move. Three of them are PAID and COMPLETED.',
    ],
    true,
  )

  const orders = await all<OrderRow>((f, t) =>
    db
      .from('orders')
      .select('id, restaurant_id, firebase_restaurant_id, order_number, total, status, payment_status, placed_at')
      .range(f, t),
  )
  console.log(`orders read: ${orders.length}`)

  // Real orders only. A fixture cannot be in one of these groups -- re-derived below, not assumed.
  const real = orders.filter((o) => o.restaurant_id != null && o.order_number != null)

  const groups = new Map<string, OrderRow[]>()
  for (const o of real) {
    const key = `${o.restaurant_id}|${o.order_number}`
    groups.set(key, [...(groups.get(key) ?? []), o])
  }
  const duplicated = [...groups.entries()].filter(([, rows]) => rows.length > 1)

  const failures: string[] = []

  // ---- 1. the population is the one described
  console.log(`\n1. duplicate (restaurant_id, order_number) groups: ${duplicated.length}`)
  if (duplicated.length === 0) {
    console.log('   Nothing to do — no duplicates. The unique index is unblocked on this key.')
    return
  }
  if (duplicated.length > MAX_GROUPS) {
    failures.push(`${duplicated.length} duplicate groups (limit ${MAX_GROUPS}) — re-agree the scope`)
  }

  // ---- 2. no group contains a stress fixture
  //
  // A fixture carries restaurant_id NULL, so it CANNOT be in a group keyed by restaurant_id. This
  // check is here anyway: it costs one line, and the whole safety argument for #324's delete is
  // that the two populations do not mix. An assumption that cheap to test should be tested.
  const fixtureInGroup = duplicated.flatMap(([, rows]) =>
    rows.filter((r) => r.restaurant_id == null || String(r.firebase_restaurant_id ?? '').startsWith('restaurant_test_')),
  )
  console.log(`2. stress-fixture rows inside a duplicate group: ${fixtureInGroup.length}`)
  if (fixtureInGroup.length > 0) failures.push(`${fixtureInGroup.length} fixture row(s) inside a real group`)

  // ---- 3. every group has exactly two rows, and a decidable order
  for (const [key, rows] of duplicated) {
    if (rows.length !== 2) failures.push(`group ${key} holds ${rows.length} rows, not 2`)
    if (rows.some((r) => !r.placed_at)) failures.push(`group ${key} has a row with no placed_at — cannot decide which lost`)
    const times = new Set(rows.map((r) => r.placed_at))
    if (times.size !== rows.length) failures.push(`group ${key} has rows sharing a placed_at — cannot decide which lost`)
  }
  console.log(`3. groups with exactly two rows and a decidable order: ${duplicated.length - failures.length}`)

  // ---- 4. plan each move, and prove the target is free
  const numbersInUse = new Map<string, Set<number>>()
  for (const o of real) {
    const set = numbersInUse.get(String(o.restaurant_id)) ?? new Set<number>()
    set.add(Number(o.order_number))
    numbersInUse.set(String(o.restaurant_id), set)
  }

  type Move = { row: OrderRow; from: number; to: number }
  const moves: Move[] = []

  console.log('\n4. the plan:')
  for (const [, rows] of duplicated) {
    const ordered = [...rows].sort((a, b) => String(a.placed_at).localeCompare(String(b.placed_at)))
    const loser = ordered[ordered.length - 1]
    const from = Number(loser.order_number)
    const inUse = numbersInUse.get(String(loser.restaurant_id)) ?? new Set<number>()

    /*
     * The adjacent gap, which the collision itself created. Searched upward rather than assumed
     * to be exactly from+1: if a venue ever has two collisions one number apart, from+1 is taken
     * and the next free number is still the smallest edit. Bounded so a pathological venue is a
     * refusal, not a scan.
     */
    let to = from + 1
    while (inUse.has(to) && to <= from + 50) to += 1
    if (to > from + 50) {
      failures.push(`no free number within 50 of ${from} at ${loser.restaurant_id}`)
      continue
    }

    inUse.add(to)
    moves.push({ row: loser, from, to })
    const other = ordered[0]
    console.log(
      `   #${from} -> #${to}   ${loser.id}  ${loser.placed_at}  N$${loser.total}  ` +
        `${loser.status}/${loser.payment_status}` +
        `\n        (keeps #${from}: ${other.id}  ${other.placed_at}  N$${other.total})`,
    )
  }

  // ---- 5. the invariant the OLD allocator depends on survives
  //
  // count(*) and max(order_number) must stay equal per venue, or `count(*) + 1` starts returning a
  // number that is already taken -- which, with the unique index in place, is a 23505 on every
  // subsequent order at that venue. Moving into a gap preserves it; moving to a fresh high number
  // does not. This is the check that would catch a later "tidier" edit to the plan above.
  console.log('\n5. count/max invariant per affected venue, after the moves:')
  for (const restaurantId of new Set(moves.map((m) => String(m.row.restaurant_id)))) {
    const venueRows = real.filter((o) => String(o.restaurant_id) === restaurantId)
    const after = venueRows.map((o) => {
      const move = moves.find((m) => m.row.id === o.id)
      return move ? move.to : Number(o.order_number)
    })
    const max = Math.max(...after)
    const distinct = new Set(after).size
    console.log(`   ${restaurantId}  rows=${after.length}  distinct=${distinct}  max=${max}`)
    if (distinct !== after.length) failures.push(`${restaurantId} still holds a duplicate after the plan`)
    if (max !== after.length) {
      failures.push(`${restaurantId}: max ${max} != count ${after.length} after the plan — count(*)+1 would collide`)
    }
  }

  // ---- 6. nothing else in the schema carries a copy of the number
  //
  // Re-derived here rather than trusted from the docblock: if a snapshot ever starts recording
  // order_number, this refuses instead of silently making a receipt disagree with its order.
  const docs = await all<{ id: string; order_id: string | null; snapshot_json: unknown }>((f, t) =>
    db.from('receipt_documents').select('id, order_id, snapshot_json').range(f, t),
  )
  const movedIds = new Set(moves.map((m) => m.row.id))
  const docsNamingTheNumber = docs.filter(
    (d) => movedIds.has(String(d.order_id)) && JSON.stringify(d.snapshot_json ?? {}).includes('order_number'),
  )
  console.log(`\n6. receipt snapshots on a moving order that mention order_number: ${docsNamingTheNumber.length}`)
  if (docsNamingTheNumber.length > 0) {
    failures.push(`${docsNamingTheNumber.length} receipt snapshot(s) would disagree with the renumbered order`)
  }

  // ---- verdict
  console.log('')
  if (failures.length > 0) {
    console.error('REFUSING. Preconditions failed:')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`All preconditions pass. ${moves.length} order(s) would move.`)

  if (!confirmed) {
    console.log('DRY RUN — nothing written. Re-run with --confirm to apply.')
    return
  }

  for (const move of moves) {
    // `as never` matches scripts/prod/apply-is-counter-service.ts: the shared client in _guard.ts
    // is untyped, so supabase-js narrows every update payload to `never`.
    const { error } = await db
      .from('orders')
      .update({ order_number: move.to } as never)
      .eq('id', move.row.id)
    if (error) {
      console.error(`FAILED on ${move.row.id} (#${move.from} -> #${move.to}): ${error.message}`)
      console.error('Stopping. Re-run the dry run to see what remains.')
      process.exit(1)
    }
    console.log(`  moved ${move.row.id}: #${move.from} -> #${move.to}`)
  }
  console.log(`\nDone. ${moves.length} order(s) renumbered. Re-run probe-127-duplicate-order-numbers.mjs.`)
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
