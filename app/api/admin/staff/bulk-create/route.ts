/**
 * POST /api/admin/staff/bulk-create
 *
 * ============================================================================================
 * A WAITER WITH NO WORK EMAIL, CREATED DIRECTLY -- NOT INVITED.
 * ============================================================================================
 *
 * POST /api/admin/invites is the right tool when the person has an email and accepts their own
 * invite. It is the wrong tool for a floor of waiters management is creating in bulk before
 * service: nobody is running fifteen invite flows, and most have no work email to send one to.
 *
 * This route creates the person directly -- public.users (no email, no auth.users account:
 * public.users has zero foreign keys to auth.users, per 20260829131000's own measurement),
 * restaurant_users (the membership + base role) and staff_members (name + the permission-override
 * link), then sets their terminal PIN in the same call. Three writes and a PIN, one request,
 * because a manager doing this for ten people at once should not need ten trips through the UI.
 *
 * DEPENDS ON 20260829131100_users_email_nullable.sql (Deploy 3, not yet applied to production as
 * of this route's creation). Until that migration lands, every insert here fails on the
 * users.email NOT NULL constraint -- loudly, per-entry, not silently. This route is buildable and
 * shippable ahead of that migration; it will not FUNCTION until the migration does. That is
 * deliberate: the schema, the route and the UI are one feature, and the code should exist and be
 * reviewable before the schema flip that switches it on, not written in a rush after.
 *
 * NO PLACEHOLDER EMAILS. Never invents an address to satisfy a constraint -- the whole point of
 * the nullable column is that NULL is the honest value for "no login", not a value to route
 * around.
 *
 * PARTIAL SUCCESS, NOT ALL-OR-NOTHING. PostgREST gives no multi-statement transaction (the same
 * constraint order-lines.ts's own writers document), and a batch of ten people should not lose
 * the nine who were fine because the tenth had a bad PIN. Each entry is processed independently
 * and reported independently; a person who was already partially created (their public.users row
 * written, then a later step failed) is reported as failed with what succeeded named, not silently
 * left as an orphan the caller cannot see.
 */
import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest, getRestaurantIdForUser } from '@/lib/supabase/admin-restaurant-auth'
import { requirePermission } from '@/lib/permissions/authorize'
import { PERMISSIONS } from '@/lib/permissions'
import { resolveStaffAssignableRoleSlug } from '@/lib/restaurant-roles/server-roles'
import { hashTerminalPin, validateTerminalPin } from '@/lib/terminal-auth/pin-credentials'

export const dynamic = 'force-dynamic'

type BulkStaffEntry = {
  name?: unknown
  role?: unknown
  pin?: unknown
}

type EntryResult = {
  name: string
  ok: boolean
  user_id?: string
  error?: string
}

export async function POST(request: Request) {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const restaurantId = await getRestaurantIdForUser(supabase, user.id)
    const denied = await requirePermission(user.id, restaurantId, PERMISSIONS.STAFF_MANAGE)
    if (denied) return denied

    const body = (await request.json().catch(() => ({}))) as { staff?: unknown }
    const entries = Array.isArray(body.staff) ? (body.staff as BulkStaffEntry[]) : []

    if (entries.length === 0) {
      return NextResponse.json({ error: 'staff must be a non-empty array' }, { status: 400 })
    }
    if (entries.length > 50) {
      return NextResponse.json(
        { error: 'staff cannot carry more than 50 entries in one request' },
        { status: 400 },
      )
    }

    const results: EntryResult[] = []

    for (const entry of entries) {
      const name = String(entry.name ?? '').trim()
      const roleInput = String(entry.role ?? '').trim()
      const pin = String(entry.pin ?? '').trim()

      if (!name) {
        results.push({ name: name || '(blank)', ok: false, error: 'Name is required.' })
        continue
      }
      if (!validateTerminalPin(pin)) {
        results.push({ name, ok: false, error: 'PIN must be exactly 4 digits.' })
        continue
      }
      const role = await resolveStaffAssignableRoleSlug(supabase, restaurantId, roleInput)
      if (!role) {
        results.push({ name, ok: false, error: `"${roleInput}" is not a valid role.` })
        continue
      }

      /**
       * public.users first: everything else references its id.
       *
       * id.column_default IS NULL (confirmed against staging 2026-08-28 -- the row this route
       * was leaving unset failed with "null value in column id", before the insert could even
       * reach the email check the docblock above warns about). Every OTHER writer of this table
       * sets id explicitly, mirroring an existing auth.users id (lib/auth/ensure-public-user.ts).
       * This route has no auth id to mirror -- the whole point is a person with no login -- so it
       * generates a fresh one, the same way app/api/admin/invites/route.ts's own token does.
       */
      const { data: createdUser, error: userError } = await supabase
        .from('users')
        .insert({ id: crypto.randomUUID(), name, email: null })
        .select('id')
        .single()

      if (userError || !createdUser?.id) {
        results.push({
          name,
          ok: false,
          error:
            userError?.message?.includes('null value in column "email"')
              ? 'Could not create this person yet -- the schema change that allows a waiter with ' +
                'no email has not reached production. Ask whoever is running tonight\'s deploy.'
              : userError?.message || 'Could not create this person.',
        })
        continue
      }
      const userId = String(createdUser.id)

      const { error: membershipError } = await supabase.from('restaurant_users').insert({
        restaurant_id: restaurantId,
        user_id: userId,
        role,
        invited_by: user.id,
        invite_accepted: true,
      })
      if (membershipError) {
        results.push({
          name,
          ok: false,
          user_id: userId,
          error: `Created, but could not add them to the restaurant: ${membershipError.message}`,
        })
        continue
      }

      const { error: staffMemberError } = await supabase.from('staff_members').insert({
        restaurant_id: restaurantId,
        user_id: userId,
        name,
        email: null,
        role,
        active: true,
      })
      if (staffMemberError) {
        results.push({
          name,
          ok: false,
          user_id: userId,
          error: `Added to the restaurant, but their permissions record failed: ${staffMemberError.message}`,
        })
        continue
      }

      const { pinHash, pinSalt } = await hashTerminalPin(pin)
      const { error: pinError } = await supabase.from('terminal_authorization_credentials').insert({
        user_id: userId,
        restaurant_id: restaurantId,
        pin_hash: pinHash,
        pin_salt: pinSalt,
      })
      if (pinError) {
        results.push({
          name,
          ok: false,
          user_id: userId,
          error: `Created, but their PIN could not be set: ${pinError.message}. Set it from Terminal PINs.`,
        })
        continue
      }

      // Best-effort, matching writeOrderLines' own established choice for its creation events:
      // the person and their PIN are already correctly created by this point, and a missing audit
      // row is a logged gap, not a reason to report someone who was actually created as failed.
      const { error: auditError } = await supabase.from('authorization_events').insert({
        event_type: 'credential_set',
        actor_user_id: user.id,
        restaurant_id: restaurantId,
        terminal_id: null,
        detail: { target_user_id: userId, source: 'bulk_staff_create' },
      })
      if (auditError) {
        console.error('[staff/bulk-create] audit row failed for', userId, auditError)
      }

      results.push({ name, ok: true, user_id: userId })
    }

    const createdCount = results.filter((r) => r.ok).length
    return NextResponse.json({
      success: createdCount > 0,
      created_count: createdCount,
      failed_count: results.length - createdCount,
      results,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to create staff'
    const status =
      message.includes('authorization') || message.includes('session')
        ? 401
        : message.includes('permission')
          ? 403
          : 500
    console.error('[staff/bulk-create] failed:', error)
    return NextResponse.json({ error: message }, { status })
  }
}
