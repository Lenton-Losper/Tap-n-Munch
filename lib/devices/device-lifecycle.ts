/**
 * THE LIFECYCLE WRITES for payment terminals and kitchen/bar screens.
 *
 * Every function here:
 *   - is called only AFTER the route has authenticated the user, resolved THEIR restaurant from
 *     their session (never from the request) and checked the permission for the device's kind;
 *   - reads and writes the row by its exact id AND that restaurant id, so a user of Restaurant A
 *     cannot touch Restaurant B's device by changing a UUID -- a foreign id is simply "not found";
 *   - refuses an action the device's current state does not allow (lib/devices/device-state.ts
 *     allowedActions -- the same table the UI renders from);
 *   - writes one audit_logs event in the device's restaurant;
 *   - writes restaurant_terminals only. No payment, order or intent row is read or changed.
 *
 * WHAT EACH ACTION MEANS (the UI copy says the same thing):
 *   deactivate  status 'inactive'. The device cannot use FlashTap (validateTerminalRecord and the
 *               refresh route both require status 'active'). Its registration, device identity and
 *               refresh session are KEPT, so Reactivate resumes it without a new code.
 *   reactivate  'inactive' -> 'active'.
 *   revoke      kitchen/bar screens: status 'revoked', active false, refresh session and any code
 *               cleared. The row stays so the screen can be re-paired by name.
 *   remove      DELETE the registration. The device identity and its session go with the row, so
 *               the device is free to be activated anywhere. Payment and order history does not
 *               reference restaurant_terminals by foreign key and is untouched.
 *   cancel_code DELETE a code row nothing ever activated.
 *   approve_transfer
 *               record that an authorized user of THIS restaurant consents to moving the device
 *               that asked (transfer_request_device_id) here. The move itself happens when the
 *               device retries, inside transfer_terminal_device().
 */
import type { createServerSupabaseClient } from '@/lib/supabase/server'
import { allowedActions, deviceKind, type DeviceAction, type DeviceRow } from '@/lib/devices/device-state'

type Db = ReturnType<typeof createServerSupabaseClient>

export const DEVICE_ROW_COLUMNS =
  'id, restaurant_id, station_kind, status, active, terminal_name, name, model, sn, device_id, device_serial, ' +
  'app_version, created_at, activated_at, last_seen_at, activation_code, activation_code_expires_at, ' +
  'refresh_token_hash, refresh_token_expires_at, transfer_request_device_id, transfer_requested_at, transfer_approved_at'

export type LifecycleResult =
  | { ok: true; device?: DeviceRow; auditRecorded: boolean }
  | { ok: false; status: number; error: string; code: string }

const NOT_FOUND: LifecycleResult = {
  ok: false,
  status: 404,
  error: 'This device was not found in your restaurant.',
  code: 'DEVICE_NOT_FOUND',
}

export async function loadDevice(supabase: Db, restaurantId: string, deviceId: string): Promise<DeviceRow | null> {
  const { data, error } = await supabase
    .from('restaurant_terminals')
    .select(DEVICE_ROW_COLUMNS)
    .eq('id', deviceId)
    .eq('restaurant_id', restaurantId)
    .maybeSingle()
  if (error) throw error
  return (data as unknown as DeviceRow | null) ?? null
}

async function audit(
  supabase: Db,
  restaurantId: string,
  deviceId: string,
  action: string,
  metadata: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await supabase.from('audit_logs').insert({
    restaurant_id: restaurantId,
    action,
    entity_type: 'terminal',
    entity_id: deviceId,
    metadata,
  })
  if (error) {
    console.error('[devices] audit event not recorded', { action, deviceId, error })
    return false
  }
  return true
}

function refuse(action: DeviceAction): LifecycleResult {
  return {
    ok: false,
    status: 409,
    error: `This device cannot be ${
      {
        rename: 'renamed',
        deactivate: 'deactivated',
        reactivate: 'reactivated',
        revoke: 'disconnected',
        remove: 'removed',
        cancel_code: 'cancelled',
        approve_transfer: 'transferred',
      }[action]
    } in its current state.`,
    code: 'ACTION_NOT_ALLOWED',
  }
}

type Ctx = { supabase: Db; restaurantId: string; userId: string; deviceId: string; now?: number }

async function guarded(ctx: Ctx, action: DeviceAction): Promise<DeviceRow | LifecycleResult> {
  const row = await loadDevice(ctx.supabase, ctx.restaurantId, ctx.deviceId)
  if (!row) return NOT_FOUND
  if (!allowedActions(row, ctx.now).includes(action)) return refuse(action)
  return row
}

function isResult(v: DeviceRow | LifecycleResult): v is LifecycleResult {
  return typeof (v as LifecycleResult).ok === 'boolean'
}

async function updateScoped(ctx: Ctx, patch: Record<string, unknown>): Promise<DeviceRow | null> {
  const { data, error } = await ctx.supabase
    .from('restaurant_terminals')
    .update(patch)
    .eq('id', ctx.deviceId)
    .eq('restaurant_id', ctx.restaurantId)
    .select(DEVICE_ROW_COLUMNS)
    .maybeSingle()
  if (error) throw error
  return (data as unknown as DeviceRow | null) ?? null
}

export async function renameDevice(ctx: Ctx, rawName: unknown): Promise<LifecycleResult> {
  const name = String(rawName ?? '').trim()
  if (!name || name.length > 60) {
    return { ok: false, status: 400, error: 'Enter a name of 1 to 60 characters.', code: 'INVALID_NAME' }
  }
  const row = await guarded(ctx, 'rename')
  if (isResult(row)) return row
  const updated = await updateScoped(ctx, { terminal_name: name, name })
  if (!updated) return NOT_FOUND
  const auditRecorded = await audit(ctx.supabase, ctx.restaurantId, ctx.deviceId, 'terminal.renamed', {
    by: ctx.userId,
    from: row.terminal_name ?? row.name ?? null,
    to: name,
  })
  return { ok: true, device: updated, auditRecorded }
}

export async function deactivateDevice(ctx: Ctx): Promise<LifecycleResult> {
  const row = await guarded(ctx, 'deactivate')
  if (isResult(row)) return row
  const updated = await updateScoped(ctx, { status: 'inactive' })
  if (!updated) return NOT_FOUND
  const auditRecorded = await audit(ctx.supabase, ctx.restaurantId, ctx.deviceId, 'terminal.deactivated', {
    by: ctx.userId,
    kind: deviceKind(row),
  })
  return { ok: true, device: updated, auditRecorded }
}

export async function reactivateDevice(ctx: Ctx): Promise<LifecycleResult> {
  const row = await guarded(ctx, 'reactivate')
  if (isResult(row)) return row
  const updated = await updateScoped(ctx, { status: 'active' })
  if (!updated) return NOT_FOUND
  const auditRecorded = await audit(ctx.supabase, ctx.restaurantId, ctx.deviceId, 'terminal.reactivated', {
    by: ctx.userId,
    kind: deviceKind(row),
  })
  return { ok: true, device: updated, auditRecorded }
}

export async function revokeDevice(ctx: Ctx): Promise<LifecycleResult> {
  const row = await guarded(ctx, 'revoke')
  if (isResult(row)) return row
  const updated = await updateScoped(ctx, {
    status: 'revoked',
    active: false,
    activation_code: null,
    activation_code_expires_at: null,
    refresh_token_hash: null,
    refresh_token_expires_at: null,
  })
  if (!updated) return NOT_FOUND
  const auditRecorded = await audit(ctx.supabase, ctx.restaurantId, ctx.deviceId, 'terminal.revoked', {
    by: ctx.userId,
    kind: deviceKind(row),
  })
  return { ok: true, device: updated, auditRecorded }
}

async function deleteScoped(ctx: Ctx): Promise<boolean> {
  const { data, error } = await ctx.supabase
    .from('restaurant_terminals')
    .delete()
    .eq('id', ctx.deviceId)
    .eq('restaurant_id', ctx.restaurantId)
    .select('id')
  if (error) throw error
  return Array.isArray(data) && data.length === 1
}

export async function removeDevice(ctx: Ctx): Promise<LifecycleResult> {
  const row = await guarded(ctx, 'remove')
  if (isResult(row)) return row
  if (!(await deleteScoped(ctx))) return NOT_FOUND
  const auditRecorded = await audit(ctx.supabase, ctx.restaurantId, ctx.deviceId, 'terminal.removed', {
    by: ctx.userId,
    kind: deviceKind(row),
    name: row.terminal_name ?? row.name ?? null,
    // The identity this removal released, so "which device was this?" stays answerable.
    releasedDeviceId: row.device_id ?? null,
    serial: row.sn ?? null,
  })
  return { ok: true, auditRecorded }
}

export async function cancelActivationCode(ctx: Ctx): Promise<LifecycleResult> {
  const row = await guarded(ctx, 'cancel_code')
  if (isResult(row)) return row
  if (row.activated_at || row.device_id) return refuse('cancel_code')
  if (!(await deleteScoped(ctx))) return NOT_FOUND
  const auditRecorded = await audit(ctx.supabase, ctx.restaurantId, ctx.deviceId, 'terminal.activation_code_cancelled', {
    by: ctx.userId,
    kind: deviceKind(row),
  })
  return { ok: true, auditRecorded }
}

export async function approveTransfer(ctx: Ctx): Promise<LifecycleResult> {
  const row = await guarded(ctx, 'approve_transfer')
  if (isResult(row)) return row
  const updated = await updateScoped(ctx, {
    transfer_approved_at: new Date(ctx.now ?? Date.now()).toISOString(),
    transfer_approved_by: ctx.userId,
  })
  if (!updated) return NOT_FOUND
  const auditRecorded = await audit(ctx.supabase, ctx.restaurantId, ctx.deviceId, 'terminal.transfer_approved', {
    by: ctx.userId,
    deviceId: row.transfer_request_device_id ?? null,
  })
  return { ok: true, device: updated, auditRecorded }
}
