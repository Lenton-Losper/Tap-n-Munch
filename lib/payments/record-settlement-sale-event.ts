import type { createServerSupabaseClient } from '@/lib/supabase/server'
import type { SettlementPaymentMethod } from '@/lib/payments/payment-integrity'

type Supabase = ReturnType<typeof createServerSupabaseClient>

/**
 * audit_logs.action written when a card settlement completed but its SALE ledger row could
 * not be written. Consumed by computePlatformAlerts() -- see lib/platform/dashboard.ts.
 *
 * This is the whole point of #156. The money moved and the ledger does not know: a refund
 * against that order will answer SALE_NOT_FOUND before it ever reaches Finatic.
 */
export const SALE_LEDGER_WRITE_FAILED_ACTION = 'payment.sale_ledger_write_failed'

/**
 * audit_logs.action written when a CARD settlement carried nothing to record the sale under.
 *
 * Deliberately a separate action from the failure above, because the remedy differs: a failed
 * write is a database or transport problem and may succeed on a retry, whereas a skipped write
 * means the terminal settled a card without sending a gateway reference and no retry can
 * invent one. Both are gaps in the ledger; only one is recoverable by trying again.
 */
export const SALE_LEDGER_WRITE_SKIPPED_ACTION = 'payment.sale_ledger_write_skipped'

/** reason_code stamped on ledger rows this route writes. See the note on classification below. */
export const SETTLE_CARD_REASON_CODE = 'settle_card'

export type RecordSettlementSaleEventParams = {
  restaurantId: string
  /** The orders the atomic claim actually flipped to paid -- never the requested set. */
  orderIds: string[]
  method: SettlementPaymentMethod
  /** Finatic merchant order number. Absent on cash by definition; absent on card is a defect. */
  businessOrderNo: string
  /** Terminal voucher no / gateway reference. Falls back to businessOrderNo -- see below. */
  transactionId: string
  /** SERVER-computed order total. Never the client-supplied amount. */
  amount: number
  currency?: string
  terminalId: string | null
  /** Only ever a real PIN-verified user id, or null. Never a placeholder. */
  initiatedBy: string | null
  tabId?: string | null
  logPrefix: string
}

export type RecordSettlementSaleEventResult =
  | { outcome: 'recorded'; paymentEventId: string }
  /**
   * The row already existed with an identical payload -- a retried settle, or the terminal's
   * own POST to /api/terminal/payment-events/sale got there first. Not a problem: exactly one
   * row describes this money, which is the goal.
   */
  | { outcome: 'already_recorded'; paymentEventId: string }
  /** Same business_order_no, DIFFERENT orders or amount. Two truths about one reference. */
  | { outcome: 'conflict'; reason: string }
  | { outcome: 'skipped_cash' }
  | { outcome: 'skipped'; reason: 'missing_business_order_no' | 'non_positive_amount' | 'no_orders' }
  | { outcome: 'failed'; reason: string }

/** The outcomes that mean the ledger does NOT have a row for money that moved. */
export function isLedgerGapOutcome(outcome: RecordSettlementSaleEventResult['outcome']): boolean {
  return outcome === 'failed' || outcome === 'skipped' || outcome === 'conflict'
}

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23505' || Boolean(error?.message?.includes('duplicate key'))
}

function orderIdSetsEqual(a: string[], b: string[]): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size !== setB.size) return false
  for (const id of setA) {
    if (!setB.has(id)) return false
  }
  return true
}

/**
 * Records the SALE ledger row for a settlement, server-side and awaited.
 *
 * NEVER THROWS, and never reports failure upward as an error the caller should act on by
 * refusing the settlement. By the time this is called the atomic claim has already flipped the
 * orders to paid -- the money has moved. Failing the settle because the ledger write failed
 * would turn a bookkeeping gap into a refused payment at the counter, which is strictly worse.
 * So every failure here is recorded loudly and execution continues.
 *
 * WHY THIS IS NOT ATOMIC. The settle route makes eight sequential `await supabase` calls plus
 * two more in lib/tabs/settle-tab-state.ts, uses zero RPCs, and the Supabase JS client has no
 * transaction support -- each call is a separate PostgREST request. Same-transaction is
 * therefore unreachable by rearranging this code; it needs a plpgsql RPC doing the claim and
 * this insert together, which is a tracked follow-up. What this does achieve is removing the
 * client dependency and the unawaited fire-and-forget call that produced the 294-row gap: the
 * write is now server-side, awaited, error-checked, and its failures are durable.
 *
 * CLASSIFICATION. event_type must be 'sale' -- the CHECK constraint allows only
 * sale/refund_attempted/refund_succeeded/refund_failed, so 'settle_card' is not a legal
 * event_type. The settle-route origin is carried in reason_code instead
 * (SETTLE_CARD_REASON_CODE), which distinguishes these rows from the terminal's own posts
 * (reason_code 'sale') without inventing a constraint-violating event type.
 *
 * DEDUP AGAINST THE TERMINAL'S OWN POST IS FREE. Both this write and
 * /api/terminal/payment-events/sale use business_order_no as idempotency_key, and the table
 * carries UNIQUE (restaurant_id, idempotency_key). Whichever lands first wins; the second gets
 * 23505 and resolves to 'already_recorded' after its payload is confirmed to match. One row
 * per payment, regardless of which path fires or in what order.
 *
 * initiated_by. The base migration declares it NOT NULL REFERENCES users(id), but
 * 20260705360000_payment_events_initiated_by_nullable dropped that NOT NULL specifically so
 * sale rows -- which have no PIN-verified human actor -- can be written; terminal_id is the
 * relevant identity for those. So there is no NOT-NULL-with-no-natural-value problem to solve
 * and nothing to invent: this passes the real attributed user id when a settle authorization
 * token was verified, and null otherwise.
 */
export async function recordSettlementSaleEvent(
  supabase: Supabase,
  params: RecordSettlementSaleEventParams,
): Promise<RecordSettlementSaleEventResult> {
  const {
    restaurantId,
    orderIds,
    method,
    businessOrderNo,
    transactionId,
    amount,
    terminalId,
    initiatedBy,
    tabId,
    logPrefix,
  } = params
  const currency = params.currency || 'NAD'

  // CASH IS EXCLUDED BY DESIGN, and this returns before touching the database.
  //
  // business_order_no and origin_business_order_no are both NOT NULL and both are Finatic
  // artifacts. A cash payment has neither, so the only way to give cash a ledger row is to
  // invent a synthetic reference -- a schema decision, not one this function may take. Cash
  // therefore continues to produce no SALE row, exactly as it does today. Cash refunds remain
  // impossible for the same reason (#137, still open).
  //
  // Logged rather than silent so a settle that produced no ledger row is explicable from the
  // logs alone, instead of being indistinguishable from the failure this issue is about.
  if (method === 'cash') {
    console.log(
      `${logPrefix} sale ledger skipped: cash settlement (correct by design)`,
      JSON.stringify({
        marker: 'payment.sale_ledger_skipped_cash',
        severity: 'info',
        requiresAttention: false,
        restaurantId,
        orderIds,
        amount,
        terminalId,
      }),
    )
    return { outcome: 'skipped_cash' }
  }

  if (orderIds.length === 0) {
    await reportLedgerGap(supabase, {
      action: SALE_LEDGER_WRITE_SKIPPED_ACTION,
      restaurantId,
      entityId: tabId ?? null,
      logPrefix,
      message: 'sale ledger skipped: no claimed orders',
      metadata: { reason: 'no_orders', orderIds, businessOrderNo, amount, terminalId, tabId },
    })
    return { outcome: 'skipped', reason: 'no_orders' }
  }

  // A card settlement with no gateway reference cannot be recorded and must not be faked.
  // This is the guard the old client call had -- `if (businessOrderNo && transactionId)` --
  // except that one skipped SILENTLY with a console.warn into a worker that had no logging.
  // Same guard, made durable: a skipped ledger entry is now as visible as a failed one.
  if (!businessOrderNo) {
    await reportLedgerGap(supabase, {
      action: SALE_LEDGER_WRITE_SKIPPED_ACTION,
      restaurantId,
      entityId: tabId ?? null,
      logPrefix,
      message: 'sale ledger skipped: card settlement carried no business_order_no',
      metadata: {
        reason: 'missing_business_order_no',
        orderIds,
        amount,
        method,
        terminalId,
        tabId,
      },
    })
    return { outcome: 'skipped', reason: 'missing_business_order_no' }
  }

  // payment_events_amount_positive CHECK (amount > 0). Caught here so the reason reads
  // "non_positive_amount" rather than surfacing as an opaque constraint violation.
  if (!Number.isFinite(amount) || amount <= 0) {
    await reportLedgerGap(supabase, {
      action: SALE_LEDGER_WRITE_SKIPPED_ACTION,
      restaurantId,
      entityId: tabId ?? null,
      logPrefix,
      message: 'sale ledger skipped: settlement amount is not positive',
      metadata: {
        reason: 'non_positive_amount',
        amount,
        orderIds,
        businessOrderNo,
        terminalId,
        tabId,
      },
    })
    return { outcome: 'skipped', reason: 'non_positive_amount' }
  }

  // Order #120 (the known-good control) has transaction_id identical to business_order_no --
  // the terminal sends the merchant order number as both. Falling back to it therefore
  // reproduces the shape real rows already have rather than writing a null.
  const resolvedTransactionId = transactionId || businessOrderNo

  const insertPayload = {
    restaurant_id: restaurantId,
    order_ids: orderIds,
    event_type: 'sale' as const,
    business_order_no: businessOrderNo,
    origin_business_order_no: businessOrderNo,
    transaction_id: resolvedTransactionId,
    terminal_id: terminalId,
    app_version: null,
    amount,
    currency,
    initiated_by: initiatedBy,
    idempotency_key: businessOrderNo,
    reason_code: SETTLE_CARD_REASON_CODE,
  }

  const { data: created, error: insertError } = await supabase
    .from('payment_events')
    .insert(insertPayload)
    .select('id')
    .single()

  if (!insertError && created) {
    console.log(
      `${logPrefix} sale ledger recorded`,
      JSON.stringify({
        marker: 'payment.sale_ledger_recorded',
        severity: 'info',
        requiresAttention: false,
        paymentEventId: created.id,
        restaurantId,
        orderIds,
        businessOrderNo,
        amount,
        currency,
        terminalId,
      }),
    )
    return { outcome: 'recorded', paymentEventId: String(created.id) }
  }

  if (isUniqueViolation(insertError)) {
    const { data: existing, error: existingError } = await supabase
      .from('payment_events')
      .select('id, order_ids, amount')
      .eq('restaurant_id', restaurantId)
      .eq('idempotency_key', businessOrderNo)
      .maybeSingle()

    if (existingError || !existing) {
      // The unique index says a row exists and the read cannot produce it. Treat as a gap:
      // claiming "already recorded" on the strength of an error would be exactly the kind of
      // unverified assumption that let 294 payments go unrecorded.
      await reportLedgerGap(supabase, {
        action: SALE_LEDGER_WRITE_FAILED_ACTION,
        restaurantId,
        entityId: tabId ?? null,
        logPrefix,
        message: 'sale ledger conflicted but the existing row could not be read back',
        metadata: {
          reason: 'existing_row_unreadable',
          businessOrderNo,
          orderIds,
          amount,
          terminalId,
          tabId,
          error: existingError?.message ?? 'no row returned',
        },
      })
      return { outcome: 'failed', reason: 'existing_row_unreadable' }
    }

    const existingOrderIds = Array.isArray(existing.order_ids)
      ? existing.order_ids.map((id: unknown) => String(id))
      : []
    const sameOrders = orderIdSetsEqual(existingOrderIds, orderIds)
    const sameAmount = Number(existing.amount) === Number(amount)

    if (sameOrders && sameAmount) {
      console.log(
        `${logPrefix} sale ledger already recorded for this reference`,
        JSON.stringify({
          marker: 'payment.sale_ledger_already_recorded',
          severity: 'info',
          requiresAttention: false,
          paymentEventId: existing.id,
          restaurantId,
          businessOrderNo,
          orderIds,
        }),
      )
      return { outcome: 'already_recorded', paymentEventId: String(existing.id) }
    }

    // One gateway reference, two different claims about what it paid for. Never routine.
    await reportLedgerGap(supabase, {
      action: SALE_LEDGER_WRITE_FAILED_ACTION,
      restaurantId,
      entityId: tabId ?? null,
      logPrefix,
      message: 'sale ledger conflict: business_order_no already records different orders/amount',
      metadata: {
        reason: 'idempotency_conflict',
        businessOrderNo,
        existing: { paymentEventId: existing.id, orderIds: existingOrderIds, amount: existing.amount },
        incoming: { orderIds, amount },
        terminalId,
        tabId,
      },
    })
    return { outcome: 'conflict', reason: 'idempotency_conflict' }
  }

  await reportLedgerGap(supabase, {
    action: SALE_LEDGER_WRITE_FAILED_ACTION,
    restaurantId,
    entityId: tabId ?? null,
    logPrefix,
    message: 'sale ledger insert failed',
    metadata: {
      reason: 'insert_failed',
      businessOrderNo,
      orderIds,
      amount,
      currency,
      terminalId,
      tabId,
      error: insertError?.message ?? 'unknown error',
      errorCode: insertError?.code ?? null,
    },
  })
  return { outcome: 'failed', reason: insertError?.message ?? 'insert_failed' }
}

/**
 * Records a ledger gap in the two places it has to be visible, and never throws.
 *
 *  - console.error with a structured marker carrying severity/requiresAttention, so the
 *    Worker logs enabled by #155 carry something a human or a query can find. The previous
 *    implementation's console.warn went into a worker with logging switched off, which is why
 *    the July outage left no trace at all.
 *  - audit_logs, matching the shape handleTerminalPaymentFailed uses, so it survives the log
 *    retention window and can be alerted on. computePlatformAlerts queries these actions.
 */
async function reportLedgerGap(
  supabase: Supabase,
  args: {
    action: string
    restaurantId: string
    entityId: string | null
    logPrefix: string
    message: string
    metadata: Record<string, unknown>
  },
): Promise<void> {
  const severity = args.action === SALE_LEDGER_WRITE_FAILED_ACTION ? 'critical' : 'warning'

  console.error(
    `${args.logPrefix} ${args.message}`,
    JSON.stringify({
      marker: args.action,
      severity,
      requiresAttention: true,
      restaurantId: args.restaurantId,
      ...args.metadata,
    }),
  )

  try {
    const { error } = await supabase.from('audit_logs').insert({
      restaurant_id: args.restaurantId,
      action: args.action,
      entity_type: 'payment_events',
      entity_id: args.entityId,
      metadata: {
        ...args.metadata,
        severity,
        requiresAttention: true,
        message: args.message,
      },
    })
    if (error) {
      // Both durable records are now gone. Nothing left to escalate to, so say so plainly
      // rather than swallowing it -- this is the last line before the gap is invisible again.
      console.error(
        `${args.logPrefix} CRITICAL: could not audit the sale ledger gap either`,
        JSON.stringify({
          marker: 'payment.sale_ledger_audit_failed',
          severity: 'critical',
          requiresAttention: true,
          originalAction: args.action,
          restaurantId: args.restaurantId,
          error: error.message,
        }),
      )
    }
  } catch (auditError) {
    console.error(
      `${args.logPrefix} CRITICAL: could not audit the sale ledger gap either`,
      JSON.stringify({
        marker: 'payment.sale_ledger_audit_failed',
        severity: 'critical',
        requiresAttention: true,
        originalAction: args.action,
        restaurantId: args.restaurantId,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      }),
    )
  }
}
