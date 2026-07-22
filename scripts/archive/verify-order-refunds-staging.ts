/**
 * Staging verification: append-only refund_events ledger + cap enforcement.
 *   npx tsx scripts/verify-order-refunds-staging.ts
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { randomUUID } from 'crypto'
import { createRefund, RefundValidationError } from '../lib/refunds/create-refund'
import { TEST_RESTAURANT_ID } from '../tests/e2e/constants'

config({ path: '.env.test', override: true })

if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL
}

const STAGING_REF = 'mdqjpxwczrhkxkbqatqa'
const url = process.env.SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!url?.includes(STAGING_REF)) {
  throw new Error('Refusing: not staging Supabase (.env.test)')
}

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const tag = `refund-${Date.now()}`

const created = {
  orderIds: [] as string[],
  paymentIds: [] as string[],
  refundIds: [] as string[],
  staffMemberIds: [] as string[],
  userIds: [] as string[],
}

async function cleanup() {
  if (created.refundIds.length) {
    await db.from('refund_events').delete().in('id', created.refundIds)
  }
  if (created.paymentIds.length) {
    await db.from('refund_events').delete().in('payment_id', created.paymentIds)
    await db.from('payments').delete().in('id', created.paymentIds)
  }
  if (created.orderIds.length) {
    await db.from('orders').delete().in('id', created.orderIds)
  }
  for (const userId of created.userIds) {
    await db.auth.admin.deleteUser(userId)
  }
  if (created.staffMemberIds.length) {
    await db.from('staff_members').delete().in('id', created.staffMemberIds)
  }
}

async function ensureOwnerUser(): Promise<{ userId: string }> {
  const email = `${tag}.owner@flashtap-test.invalid`
  const password = `Set${randomUUID().slice(0, 8)}!1`

  const { data: authUser, error: authError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (authError || !authUser.user) throw authError ?? new Error('createUser failed')
  created.userIds.push(authUser.user.id)

  await db.from('users').upsert({
    id: authUser.user.id,
    email,
  })

  await db.from('restaurant_users').insert({
    user_id: authUser.user.id,
    restaurant_id: TEST_RESTAURANT_ID,
    role: 'owner',
  })

  const { data: staffMember, error: staffError } = await db
    .from('staff_members')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      email,
      role: 'owner',
      active: true,
    })
    .select('id')
    .single()

  if (staffError || !staffMember) throw staffError ?? new Error('staff member insert failed')
  created.staffMemberIds.push(staffMember.id)

  return { userId: authUser.user.id }
}

async function seedPaidOrderWithPayment(paymentAmount: number) {
  const { data: order, error: orderError } = await db
    .from('orders')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      table_number: 88,
      status: 'completed',
      payment_status: 'paid',
      paid_at: new Date().toISOString(),
      subtotal: paymentAmount,
      total: paymentAmount,
      items: [],
      channel: 'pos',
    })
    .select('id')
    .single()

  if (orderError || !order) throw orderError ?? new Error('order insert failed')
  created.orderIds.push(order.id)

  const { data: payment, error: paymentError } = await db
    .from('payments')
    .insert({
      restaurant_id: TEST_RESTAURANT_ID,
      order_ids: [order.id],
      amount: paymentAmount,
      method: 'card',
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .select('id, amount')
    .single()

  if (paymentError || !payment) throw paymentError ?? new Error('payment insert failed')
  created.paymentIds.push(payment.id)

  return { orderId: order.id, paymentId: payment.id, paymentAmount: Number(payment.amount) }
}

async function expectRefundRejected(
  userId: string,
  input: {
    orderId: string
    paymentId: string
    amount: number
    requestId?: string
    refundMethod?: 'cash' | 'card'
    gatewayReference?: string
  },
) {
  try {
    await createRefund(db, userId, { ...input, reason: 'should fail' })
    throw new Error(`Expected refund rejection for amount ${input.amount}`)
  } catch (error) {
    if (error instanceof RefundValidationError) {
      return error.message
    }
    throw error
  }
}

async function main() {
  await cleanup()

  const { userId } = await ensureOwnerUser()
  const { orderId, paymentId, paymentAmount } = await seedPaidOrderWithPayment(100)

  const overRefundMessage = await expectRefundRejected(userId, {
    orderId,
    paymentId,
    amount: 150,
    requestId: randomUUID(),
  })
  if (!overRefundMessage.includes('remaining refundable balance')) {
    throw new Error(`Unexpected over-refund error: ${overRefundMessage}`)
  }

  const partial1 = await createRefund(db, userId, {
    orderId,
    paymentId,
    amount: 40,
    reason: 'Partial refund 1',
    requestId: randomUUID(),
  })
  created.refundIds.push(partial1.refundId)

  if (partial1.totalRefunded !== 40 || partial1.remainingRefundable !== 60) {
    throw new Error(
      `Partial refund 1 balance wrong: total=${partial1.totalRefunded}, remaining=${partial1.remainingRefundable}`,
    )
  }

  const partial2Message = await expectRefundRejected(userId, {
    orderId,
    paymentId,
    amount: 70,
    requestId: randomUUID(),
  })
  if (!partial2Message.includes('60 remaining')) {
    throw new Error(`Expected 60 remaining rejection, got: ${partial2Message}`)
  }

  const duplicateRequestId = randomUUID()
  const partial2 = await createRefund(db, userId, {
    orderId,
    paymentId,
    amount: 35,
    reason: 'Partial refund 2',
    requestId: duplicateRequestId,
  })
  created.refundIds.push(partial2.refundId)

  if (partial2.totalRefunded !== 75 || partial2.remainingRefundable !== 25) {
    throw new Error(
      `Partial refund 2 balance wrong: total=${partial2.totalRefunded}, remaining=${partial2.remainingRefundable}`,
    )
  }

  const duplicate = await createRefund(db, userId, {
    orderId,
    paymentId,
    amount: 35,
    reason: 'Duplicate submit',
    requestId: duplicateRequestId,
  })

  if (!duplicate.alreadyProcessed) {
    throw new Error('Duplicate request_id should return alreadyProcessed')
  }
  if (duplicate.refundId !== partial2.refundId) {
    throw new Error('Duplicate request_id should return the same refund row')
  }

  const { data: paymentRow } = await db
    .from('payments')
    .select('id, amount, status')
    .eq('id', paymentId)
    .single()

  if (Number(paymentRow?.amount) !== paymentAmount) {
    throw new Error('payments row was modified — must remain unchanged')
  }

  const { count: refundCount } = await db
    .from('refund_events')
    .select('id', { count: 'exact', head: true })
    .eq('payment_id', paymentId)
    .eq('status', 'completed')

  if (refundCount !== 2) {
    throw new Error(`Expected 2 completed refund_events, got ${refundCount}`)
  }

  // Card path: reject without gateway_reference
  const cardOrder = await seedPaidOrderWithPayment(50)
  const cardMissingGatewayMessage = await expectRefundRejected(userId, {
    orderId: cardOrder.orderId,
    paymentId: cardOrder.paymentId,
    amount: 10,
    refundMethod: 'card',
  })
  if (!cardMissingGatewayMessage.includes('gateway_reference is required')) {
    throw new Error(`Expected gateway_reference rejection, got: ${cardMissingGatewayMessage}`)
  }

  const gatewayReference = `gw-reversal-${tag}`
  const cardRefund1 = await createRefund(db, userId, {
    orderId: cardOrder.orderId,
    paymentId: cardOrder.paymentId,
    amount: 20,
    reason: 'Card refund',
    refundMethod: 'card',
    gatewayReference,
  })
  created.refundIds.push(cardRefund1.refundId)

  if (cardRefund1.refundMethod !== 'card' || cardRefund1.gatewayReference !== gatewayReference) {
    throw new Error('Card refund should persist refund_method and gateway_reference')
  }

  const cardRefundRetry = await createRefund(db, userId, {
    orderId: cardOrder.orderId,
    paymentId: cardOrder.paymentId,
    amount: 20,
    reason: 'Card refund retry',
    refundMethod: 'card',
    gatewayReference,
  })

  if (!cardRefundRetry.alreadyProcessed) {
    throw new Error('Card refund retry with same gateway_reference should be idempotent')
  }
  if (cardRefundRetry.refundId !== cardRefund1.refundId) {
    throw new Error('Card refund retry should return the same refund row')
  }

  const { count: cardRefundCount } = await db
    .from('refund_events')
    .select('id', { count: 'exact', head: true })
    .eq('payment_id', cardOrder.paymentId)
    .eq('status', 'completed')

  if (cardRefundCount !== 1) {
    throw new Error(`Expected 1 card refund_events row, got ${cardRefundCount}`)
  }

  console.log('ORDER_REFUNDS_STAGING_VERIFY_OK', {
    orderId,
    paymentId,
    paymentAmount,
    totalRefunded: partial2.totalRefunded,
    remainingRefundable: partial2.remainingRefundable,
    duplicateHandled: duplicate.alreadyProcessed,
    cardRefundId: cardRefund1.refundId,
    cardIdempotentRetry: cardRefundRetry.alreadyProcessed,
  })

  await cleanup()
}

main().catch(async (error) => {
  console.error('ORDER_REFUNDS_STAGING_VERIFY_FAIL', error)
  try {
    await cleanup()
  } catch {
    /* ignore */
  }
  process.exit(1)
})
