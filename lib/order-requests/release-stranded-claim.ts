import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * RELEASING A CLAIM STRANDED IN `accepting` — the rule, in one place.
 *
 * WHY A MODULE AND NOT TWO ROUTES. Two surfaces need this: the terminal, and the staff dashboard.
 * They authenticate differently — terminal JWT vs `requireStaffPermission` — but the RULE about
 * what may be released and what it becomes is identical, and it is the rule that is dangerous to
 * get wrong.
 *
 * This project already has the object lesson. `#120` guarded the terminal's close route and left
 * the dashboard's close route unguarded, because they are two routes doing one job with the rule
 * written into only one of them. Copying this logic into a second route would reproduce that
 * exactly: the day someone tightens one, the other keeps the old behaviour and nobody finds out
 * until a bill is wrong.
 *
 * So the routes own AUTHENTICATION and nothing else. They own who is asking; this owns what may
 * happen.
 */

/** The transient claim the accept route takes. The only status this may release. */
export const STRANDED_CLAIM_STATUS = 'accepting'

/**
 * Where a released claim goes, and it is deliberately NOT `accepted`.
 *
 * A dead worker proves nothing about whether the round was wanted. `accepted` would create an order
 * nobody decided on; `declined` would throw away a round a customer really placed. `waiting_review`
 * puts it back in front of staff, which is where an undecided round belongs.
 */
export const RELEASED_TO_STATUS = 'waiting_review'

export type ReleaseOutcome =
  | { ok: true; id: string; status: string }
  | { ok: false; status: number; error: string; code?: string; currentStatus?: string }

export type ReleaseActor = {
  restaurantId: string
  /** For the audit row: which terminal, or which staff user, asked. */
  actor: Record<string, unknown>
}

/**
 * Releases one stranded claim, or explains precisely why it will not.
 *
 * FAILS CLOSED AND SAYS WHICH FAILURE. A read that errors returns 503 rather than being treated as
 * "nothing to release" — the same discipline the pending-request check uses on the close paths,
 * because a failed read and an empty result are not the same fact.
 */
export async function releaseStrandedClaim(
  supabase: SupabaseClient,
  requestId: string,
  { restaurantId, actor }: ReleaseActor,
): Promise<ReleaseOutcome> {
  const normalizedId = String(requestId ?? '').trim()
  if (!normalizedId) {
    return { ok: false, status: 400, error: 'Missing request id' }
  }

  /**
   * Read first, so a refusal can say WHICH reason applies rather than answering one opaque 409.
   * The read does not authorise anything — the conditional update below does.
   */
  const { data: row, error: loadError } = await supabase
    .from('order_requests')
    .select('id, restaurant_id, tab_id, table_id, status')
    .eq('id', normalizedId)
    .maybeSingle()

  if (loadError) {
    console.error('[release-stranded-claim] load failed', { requestId: normalizedId, reason: loadError.message })
    return { ok: false, status: 503, error: 'Could not read this request. Try again.' }
  }
  if (!row) {
    return { ok: false, status: 404, error: 'Request not found' }
  }
  /**
   * Cross-tenant. 404, not 403, and deliberately the same answer as "no such id": a caller from
   * another restaurant must not learn that the id is real. Same rule as the guest routes.
   */
  if (String(row.restaurant_id) !== String(restaurantId)) {
    return { ok: false, status: 404, error: 'Request not found' }
  }
  if (String(row.status) !== STRANDED_CLAIM_STATUS) {
    return {
      ok: false,
      status: 409,
      code: 'NOT_A_STRANDED_CLAIM',
      currentStatus: String(row.status),
      error: `This request is not a stranded claim (it is ${String(row.status)}). Only a request stuck mid-accept can be released.`,
    }
  }

  /**
   * THE CONDITIONAL CLAIM, and it is the whole safety of this operation. `.eq('status','accepting')`
   * is evaluated by the database at write time, so a worker that finishes its own release a
   * millisecond earlier wins and this matches zero rows.
   */
  const { data: released, error: updateError } = await supabase
    .from('order_requests')
    .update({ status: RELEASED_TO_STATUS })
    .eq('id', normalizedId)
    .eq('status', STRANDED_CLAIM_STATUS)
    .select('id, status')
    .maybeSingle()

  if (updateError) {
    console.error('[release-stranded-claim] update failed', { requestId: normalizedId, reason: updateError.message })
    return { ok: false, status: 503, error: 'Could not release this request. Try again.' }
  }
  if (!released) {
    /**
     * Someone else got there first — almost always the accept route's own release completing. That
     * is a GOOD outcome, not an error: the row is no longer stranded either way.
     */
    return {
      ok: false,
      status: 409,
      code: 'ALREADY_RESOLVED',
      error: 'This request was resolved by something else while you were releasing it. Refresh the table.',
    }
  }

  /**
   * Audited, and the trail write must never be able to fail the release it records — the same rule
   * the payment trails follow. A stuck table that was freed but not logged is strictly better than
   * one that stayed stuck because the audit table was down.
   */
  try {
    await supabase.from('audit_logs').insert({
      restaurant_id: restaurantId,
      action: 'order_request.claim_released',
      entity_type: 'order_request',
      entity_id: normalizedId,
      metadata: {
        ...actor,
        from: STRANDED_CLAIM_STATUS,
        to: RELEASED_TO_STATUS,
        tabId: row.tab_id ?? null,
        tableId: row.table_id ?? null,
        reason: 'staff released a stranded accept claim (#120 residual, manual escape hatch)',
      },
    })
  } catch (auditError) {
    console.error('[release-stranded-claim] audit write failed', auditError)
  }

  return { ok: true, id: String(released.id), status: String(released.status) }
}
