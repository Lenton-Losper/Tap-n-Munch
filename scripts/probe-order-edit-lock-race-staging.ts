/**
 * Staging probe: a customer edit against a staff "start preparing" on the same order, run
 * against the DEPLOYED worker.
 *
 * Four scenarios, on four seeded orders. The first two are DELIBERATELY ORDERED rather than
 * raced, because a true race only exercises whichever direction it happens to fall — the first
 * run of this probe landed customer-first and never touched the direction the ruling is actually
 * about. A nondeterministic test of an asymmetric rule proves the asymmetry only half the time.
 *
 *   A  STAFF FIRST (the ruling)  lock -> staff preparing -> customer commit MUST be refused,
 *                                and the order must still carry its original items
 *   B  CUSTOMER FIRST            lock -> customer commit -> the total moved, so the order is
 *                                back in `pending` and the staff `preparing` transition fails
 *   C  TRUE RACE                 both fired together; whichever wins, the DATABASE must never
 *                                be both edited AND preparing
 *   D  TWO CUSTOMERS             a second session cannot take a live lock, and gets it once the
 *                                first is released
 *
 * Marker: PROBE_ORDER_EDIT_LOCK_RACE_OK
 * Run:    npx tsx scripts/probe-order-edit-lock-race-staging.ts
 */
// @ts-nocheck
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const WORKER =
  process.env.STAGING_WORKER_URL || 'https://flashtap-staging.llosperofficial.workers.dev'
const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.STAGING_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  ''
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY || ''
const anonKey =
  process.env.SUPABASE_ANON_KEY ||
  process.env.STAGING_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  ''

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

function log(label: string, value: unknown) {
  console.log(`== ${label} ==`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

const PRICED_LINES = [
  {
    name: 'Probe Burger',
    displayName: 'Probe Burger',
    quantity: 2,
    unitPrice: 100,
    subtotal: 173.91,
    tax: 26.09,
    total: 200,
    taxRatePercentage: 15,
    taxInclusive: true,
    priceSource: 'catalog',
  },
  {
    name: 'Probe Coke',
    displayName: 'Probe Coke',
    quantity: 1,
    unitPrice: 25,
    subtotal: 21.74,
    tax: 3.26,
    total: 25,
    taxRatePercentage: 15,
    taxInclusive: true,
    priceSource: 'catalog',
  },
]

async function main() {
  assert(url && serviceKey && anonKey, 'Need staging URL + service role + anon key')

  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const tag = `edit-race-${Date.now()}`
  const email = `${tag}@flashtap-test.invalid`
  const password = `Set${randomUUID().slice(0, 8)}!1a`
  const sessionId = `sess_${tag}`

  const { data: table } = await admin
    .from('restaurant_tables')
    .select('id, table_number, restaurant_id')
    .eq('active', true)
    .gt('table_number', 0)
    .limit(1)
    .maybeSingle()
  assert(table?.id, 'need an active table on staging')

  const { data: restaurant } = await admin
    .from('restaurants')
    .select('id, firebase_id')
    .eq('id', table.restaurant_id)
    .single()
  assert(restaurant?.id, 'restaurant missing')

  const { data: authUser, error: createUserErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  assert(!createUserErr && authUser.user?.id, `createUser failed: ${createUserErr?.message}`)
  const userId = authUser.user.id

  const seededOrderIds: string[] = []

  try {
    const { error: userRowErr } = await admin
      .from('users')
      .upsert({ id: userId, email, full_name: 'Edit Race Probe' })
    assert(!userRowErr, `users upsert failed: ${userRowErr?.message}`)

    const { data: existingOwnerRole } = await admin
      .from('restaurant_roles')
      .select('role_slug')
      .eq('restaurant_id', restaurant.id)
      .eq('role_slug', 'owner')
      .maybeSingle()
    if (!existingOwnerRole) {
      const { error: roleErr } = await admin.from('restaurant_roles').insert({
        restaurant_id: restaurant.id,
        role_slug: 'owner',
        display_name: 'Owner',
        permissions: ['orders:read', 'orders:update', 'orders:delete'],
        is_system: true,
      })
      assert(!roleErr, `restaurant_roles insert failed: ${roleErr?.message}`)
    }

    const { error: membershipErr } = await admin.from('restaurant_users').insert({
      restaurant_id: restaurant.id,
      user_id: userId,
      role: 'owner',
      invite_accepted: true,
    })
    assert(!membershipErr, `restaurant_users insert failed: ${membershipErr?.message}`)

    const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword({
      email,
      password,
    })
    assert(!signInErr && signIn.session?.access_token, `sign-in failed: ${signInErr?.message}`)
    const staffToken = signIn.session.access_token

    const guestHeaders = { 'Content-Type': 'application/json' }
    const staffHeaders = {
      Authorization: `Bearer ${staffToken}`,
      'Content-Type': 'application/json',
    }

    /** An ACCEPTED order — editable, one staff click from preparing. Priced lines are seeded
     * directly so the probe does not depend on staging's menu having a chargeable item. */
    let orderSeq = 0
    async function seedOrder() {
      orderSeq += 1
      const { data: seeded, error: seedErr } = await admin
        .from('orders')
        .insert({
          restaurant_id: restaurant.id,
          firebase_restaurant_id: restaurant.firebase_id || restaurant.id,
          table_id: table.id,
          table_number: table.table_number,
          session_id: sessionId,
          status: 'accepted',
          payment_status: 'pending',
          payment_method: 'cash',
          channel: 'table',
          items: PRICED_LINES,
          subtotal: 195.65,
          tax: 29.35,
          total: 225,
          is_closed: false,
          order_number: 889000 + orderSeq,
          placed_at: new Date().toISOString(),
        })
        .select('id, status, total')
        .single()
      assert(!seedErr && seeded?.id, `seed order failed: ${seedErr?.message}`)
      seededOrderIds.push(seeded.id)
      return seeded.id as string
    }

    const editUrlFor = (id: string) => `${WORKER}/api/guest/orders/${encodeURIComponent(id)}/edit`
    const statusUrlFor = (id: string) => `${WORKER}/api/orders/${encodeURIComponent(id)}/status`

    async function acquireLock(id: string, session = sessionId) {
      const res = await fetch(editUrlFor(id), {
        method: 'POST',
        headers: guestHeaders,
        body: JSON.stringify({ restaurantId: restaurant.id, sessionId: session }),
      })
      return { status: res.status, body: await res.json().catch(() => ({})) }
    }

    function commitEdit(id: string, lockToken: string, session = sessionId) {
      return fetch(editUrlFor(id), {
        method: 'PATCH',
        headers: guestHeaders,
        body: JSON.stringify({
          restaurantId: restaurant.id,
          sessionId: session,
          lockToken,
          // Drop the Coke: 225 -> 200.
          keep: [{ index: 0, quantity: 2 }],
        }),
      })
    }

    function setPreparing(id: string) {
      return fetch(statusUrlFor(id), {
        method: 'PATCH',
        headers: staffHeaders,
        body: JSON.stringify({ status: 'preparing' }),
      })
    }

    async function reload(id: string) {
      const { data, error } = await admin
        .from('orders')
        .select(
          'id, status, total, items, edit_lock_token, requires_reacceptance, total_before_edit, customer_edit_count',
        )
        .eq('id', id)
        .single()
      assert(!error && data, `reload failed: ${error?.message}`)
      return {
        ...data,
        lineCount: Array.isArray(data.items) ? data.items.length : 0,
      }
    }

    // =====================================================================
    // A. STAFF FIRST — the ruling. Deliberately ordered, not raced.
    // =====================================================================
    const orderA = await seedOrder()
    const lockA = await acquireLock(orderA)
    log('A: lock acquired', lockA)
    assert(lockA.status === 200 && lockA.body.lockToken, 'customer could not acquire the edit lock')
    assert(lockA.body.items?.length === 2, 'lock response should return the order lines')

    // The token must be a capability, not something a read hands out. guestCanAccessOrder admits
    // an open order on table_number alone, so a token in a read body is an edit anyone at the
    // table can perform.
    const readRes = await fetch(
      `${WORKER}/api/guest/orders/${encodeURIComponent(orderA)}?restaurantId=${encodeURIComponent(restaurant.id)}&session_id=${encodeURIComponent(sessionId)}`,
    )
    const readBody = await readRes.json().catch(() => ({}))
    assert(
      !JSON.stringify(readBody).includes(String(lockA.body.lockToken)),
      'the edit lock token leaked on a guest READ — anyone the table-number path admits could commit an edit',
    )
    assert(readBody.orders?.[0]?.edit_lock_held === true, 'the read should report a lock is held')
    console.log('A: token is not returned by a read — OK')

    const staffFirst = await setPreparing(orderA)
    const staffFirstBody = await staffFirst.json().catch(() => ({}))
    log('A: staff preparing (first)', { status: staffFirst.status, body: staffFirstBody })
    assert(staffFirst.status === 200, `staff must never be blocked by an open edit, got ${staffFirst.status}`)

    const editAfterStaff = await commitEdit(orderA, String(lockA.body.lockToken))
    const editAfterStaffBody = await editAfterStaff.json().catch(() => ({}))
    log('A: customer commit (second)', { status: editAfterStaff.status, body: editAfterStaffBody })

    const finalA = await reload(orderA)
    log('A: final order', finalA)

    assert(editAfterStaff.status === 409, `the losing edit must be 409, got ${editAfterStaff.status}`)
    assert(!editAfterStaffBody.success, 'the losing edit must not report success')
    assert(
      String(editAfterStaffBody.reason) === 'preparation_started',
      `the customer must be told the kitchen started, got reason=${editAfterStaffBody.reason}`,
    )
    assert(String(finalA.status) === 'preparing', `A: status must be preparing, got ${finalA.status}`)
    assert(finalA.lineCount === 2, `A: the items must be UNCHANGED, got ${finalA.lineCount} lines`)
    assert(Number(finalA.total) === 225, `A: the total must be unchanged, got ${finalA.total}`)
    assert(Number(finalA.customer_edit_count) === 0, 'A: no edit may be recorded')
    assert(
      finalA.edit_lock_token === null,
      'A: the staff transition must clear the lock — that is what makes the commit lose',
    )

    // Editing is closed PERMANENTLY, not just for that attempt.
    const reopenA = await acquireLock(orderA)
    log('A: re-open attempt while preparing', reopenA)
    assert(reopenA.status === 409, `A: re-opening a preparing order must be refused, got ${reopenA.status}`)
    assert(
      String(reopenA.body.reason) === 'preparation_started',
      `A: refusal must name preparation, got ${reopenA.body.reason}`,
    )
    console.log('A: STAFF WINS — OK')

    // =====================================================================
    // B. CUSTOMER FIRST — the edit lands, the total moves, staff must re-accept.
    // =====================================================================
    const orderB = await seedOrder()
    const lockB = await acquireLock(orderB)
    assert(lockB.status === 200, 'B: lock not acquired')

    const editFirst = await commitEdit(orderB, String(lockB.body.lockToken))
    const editFirstBody = await editFirst.json().catch(() => ({}))
    log('B: customer commit (first)', { status: editFirst.status, body: editFirstBody })
    assert(editFirst.status === 200, `B: the edit should land, got ${editFirst.status}`)
    assert(editFirstBody.totalChanged === true, 'B: dropping a line must be reported as a total change')
    assert(Number(editFirstBody.previousTotal) === 225, 'B: previousTotal wrong')
    assert(Number(editFirstBody.total) === 200, 'B: new total wrong')

    const staffSecond = await setPreparing(orderB)
    const staffSecondBody = await staffSecond.json().catch(() => ({}))
    log('B: staff preparing (second)', { status: staffSecond.status, body: staffSecondBody })

    const finalB = await reload(orderB)
    log('B: final order', finalB)

    assert(finalB.lineCount === 1, `B: the edit must have landed, got ${finalB.lineCount} lines`)
    assert(Number(finalB.total) === 200, `B: total must be 200, got ${finalB.total}`)
    assert(
      String(finalB.status) === 'pending',
      `B: a total-changing edit must return the order to pending for re-acceptance, got ${finalB.status}`,
    )
    assert(finalB.requires_reacceptance === true, 'B: re-acceptance flag not set')
    assert(Number(finalB.total_before_edit) === 225, 'B: the before-total the dashboard shows was not recorded')
    assert(Number(finalB.customer_edit_count) === 1, 'B: the edit was not counted')
    assert(finalB.edit_lock_token === null, 'B: a committed edit must spend its lock')
    // Staff cannot start it. Note WHICH refusal, because it is the re-acceptance requirement
    // being enforced by the existing transition table rather than by anything this feature added:
    // the order is back in `pending`, and pending -> preparing was never a legal move. Staff have
    // to Accept the new figure first. (400 for the invalid transition; 409 if the row moved
    // under the caller. Either is a refusal, and 200 is the only forbidden answer.)
    assert(
      staffSecond.status !== 200,
      `B: staff must not be able to start an order whose total changed, got ${staffSecond.status}`,
    )
    assert(
      /invalid transition|status changed/i.test(String(staffSecondBody.error)),
      `B: the refusal should say why, got ${staffSecondBody.error}`,
    )
    console.log(`B: CUSTOMER FIRST, back to review, staff refused ${staffSecond.status} — OK`)

    // And the re-acceptance path actually works: Accept the new figure, then start.
    const reaccept = await fetch(statusUrlFor(orderB), {
      method: 'PATCH',
      headers: staffHeaders,
      body: JSON.stringify({ status: 'accepted' }),
    })
    log('B: staff re-accept', { status: reaccept.status })
    assert(reaccept.status === 200, `B: staff must be able to re-accept, got ${reaccept.status}`)

    const startAfterReaccept = await setPreparing(orderB)
    log('B: staff start after re-accept', { status: startAfterReaccept.status })
    assert(
      startAfterReaccept.status === 200,
      `B: staff must be able to start after re-accepting, got ${startAfterReaccept.status}`,
    )

    const finalBAfter = await reload(orderB)
    assert(String(finalBAfter.status) === 'preparing', 'B: the order should be preparing after re-acceptance')
    // The record of what happened survives the re-acceptance — staff can still see the total moved.
    assert(Number(finalBAfter.total_before_edit) === 225, 'B: the before/after record must survive re-acceptance')
    assert(Number(finalBAfter.customer_edit_count) === 1, 'B: the edit count must survive re-acceptance')
    console.log('B: re-acceptance path works, and the edit record survives it — OK')

    // =====================================================================
    // C. THE TRUE RACE — either outcome is legal; one state is not.
    // =====================================================================
    const orderC = await seedOrder()
    const lockC = await acquireLock(orderC)
    assert(lockC.status === 200, 'C: lock not acquired')

    const [resEdit, resStaff] = await Promise.all([
      commitEdit(orderC, String(lockC.body.lockToken)),
      setPreparing(orderC),
    ])
    const [bodyEdit, bodyStaff] = await Promise.all([
      resEdit.json().catch(() => ({})),
      resStaff.json().catch(() => ({})),
    ])
    log('C: simultaneous', {
      edit: { status: resEdit.status, body: bodyEdit },
      staff: { status: resStaff.status, body: bodyStaff },
    })

    const finalC = await reload(orderC)
    log('C: final order', finalC)

    const editedC = finalC.lineCount === 1
    const preparingC = String(finalC.status) === 'preparing'

    // THE INVARIANT. Everything else is detail; this is the ruling.
    assert(
      !(editedC && preparingC),
      'FORBIDDEN STATE: the order is preparing AND carries the customer edit — an order being cooked changed underneath the kitchen',
    )
    assert(
      (resEdit.status === 200) !== (resStaff.status === 200),
      `C: exactly one side must win, got edit=${resEdit.status} staff=${resStaff.status}`,
    )
    assert(finalC.edit_lock_token === null, 'C: the lock must not survive either outcome')
    if (resStaff.status === 200) {
      assert(preparingC && !editedC, 'C: staff won but the items were edited')
      assert(Number(finalC.total) === 225, `C: staff won but the total moved to ${finalC.total}`)
      console.log('C: race fell STAFF-first — OK')
    } else {
      assert(editedC && String(finalC.status) === 'pending', 'C: customer won but the order is not back in review')
      console.log('C: race fell CUSTOMER-first — OK')
    }

    // =====================================================================
    // D. TWO CUSTOMERS — what the lock does about the other phone at the table.
    // =====================================================================
    const orderD = await seedOrder()
    const secondSession = `${sessionId}-b`
    // The second phone is a member of the same order, so ownership is not what refuses it.
    const { error: memberErr } = await admin
      .from('orders')
      .update({ member_session_id: secondSession })
      .eq('id', orderD)
    assert(!memberErr, `D: could not attach a second session: ${memberErr?.message}`)

    const lockD1 = await acquireLock(orderD)
    assert(lockD1.status === 200, 'D: first customer could not acquire')

    const lockD2 = await acquireLock(orderD, secondSession)
    log('D: second customer while the first holds it', lockD2)
    assert(lockD2.status === 409, `D: a second session must not take a live lock, got ${lockD2.status}`)
    assert(
      String(lockD2.body.reason) === 'locked_by_other',
      `D: refusal must name the other holder, got ${lockD2.body.reason}`,
    )

    // The holder re-acquiring is a RENEWAL, not a conflict — reloading mid-edit must not lock a
    // customer out of their own order for three minutes.
    const renew = await acquireLock(orderD)
    assert(renew.status === 200, `D: the holder must be able to renew, got ${renew.status}`)

    const release = await fetch(editUrlFor(orderD), {
      method: 'DELETE',
      headers: guestHeaders,
      body: JSON.stringify({
        restaurantId: restaurant.id,
        sessionId,
        lockToken: String(renew.body.lockToken),
      }),
    })
    assert(release.status === 200, `D: release failed with ${release.status}`)

    const lockD3 = await acquireLock(orderD, secondSession)
    log('D: second customer after release', lockD3)
    assert(lockD3.status === 200, `D: the lock must pass on after release, got ${lockD3.status}`)
    console.log('D: TWO CUSTOMERS — OK')

    console.log('PROBE_ORDER_EDIT_LOCK_RACE_OK')
  } finally {
    // Leaves-first. Nothing FKs to these orders in the probe, but the orders go before the staff
    // user they were created under.
    for (const id of seededOrderIds) {
      await admin.from('orders').delete().eq('id', id)
    }
    await admin.from('restaurant_users').delete().eq('user_id', userId)
    await admin.from('users').delete().eq('id', userId)
    await admin.auth.admin.deleteUser(userId)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
