/**
 * PATCH  /api/admin/devices/:deviceId  { action: 'rename'|'deactivate'|'reactivate'|'revoke'|'approve_transfer', name? }
 * DELETE /api/admin/devices/:deviceId  -- remove a registered device, or cancel a code nothing used.
 *
 * The device is looked up by its id AND the caller's own restaurant (from their session). A device
 * of another restaurant is "not found" -- the same answer as a device that does not exist -- so a
 * changed UUID can neither act on nor probe another venue's hardware. The permission checked is the
 * one for THAT device's kind. See lib/devices/device-lifecycle.ts for what each action means.
 */
import { NextResponse } from 'next/server'
import { resolveDeviceCaller, forbiddenForKind } from '@/lib/devices/device-route-auth'
import {
  approveTransfer,
  cancelActivationCode,
  deactivateDevice,
  loadDevice,
  reactivateDevice,
  removeDevice,
  renameDevice,
  revokeDevice,
  type LifecycleResult,
} from '@/lib/devices/device-lifecycle'
import { deviceKind, deviceLifecycle } from '@/lib/devices/device-state'
import { toDeviceView } from '@/lib/devices/device-view'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ deviceId: string }> }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function respond(result: LifecycleResult) {
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status })
  return NextResponse.json({
    ok: true,
    device: result.device ? toDeviceView(result.device, Date.now(), null) : null,
    auditRecorded: result.auditRecorded,
  })
}

async function authorizedContext(request: Request, params: Params['params']) {
  const caller = await resolveDeviceCaller(request)
  if (caller instanceof NextResponse) return caller
  const { deviceId } = await params
  if (!UUID_RE.test(deviceId)) {
    return NextResponse.json({ error: 'This device was not found in your restaurant.', code: 'DEVICE_NOT_FOUND' }, { status: 404 })
  }
  const row = await loadDevice(caller.supabase, caller.restaurantId, deviceId)
  if (!row) {
    return NextResponse.json({ error: 'This device was not found in your restaurant.', code: 'DEVICE_NOT_FOUND' }, { status: 404 })
  }
  const kind = deviceKind(row)
  if (!caller.canManage[kind]) return forbiddenForKind(kind)
  return { caller, row, ctx: { supabase: caller.supabase, restaurantId: caller.restaurantId, userId: caller.userId, deviceId } }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const auth = await authorizedContext(request, params)
    if (auth instanceof NextResponse) return auth
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; name?: unknown }
    switch (String(body.action ?? '')) {
      case 'rename':
        return respond(await renameDevice(auth.ctx, body.name))
      case 'deactivate':
        return respond(await deactivateDevice(auth.ctx))
      case 'reactivate':
        return respond(await reactivateDevice(auth.ctx))
      case 'revoke':
        return respond(await revokeDevice(auth.ctx))
      case 'approve_transfer':
        return respond(await approveTransfer(auth.ctx))
      default:
        return NextResponse.json({ error: 'Unknown action.', code: 'UNKNOWN_ACTION' }, { status: 400 })
    }
  } catch (error) {
    console.error('[admin/devices] action failed', error)
    return NextResponse.json({ error: 'That did not work. Try again.' }, { status: 500 })
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    const auth = await authorizedContext(request, params)
    if (auth instanceof NextResponse) return auth
    const lifecycle = deviceLifecycle(auth.row)
    const isUnusedCode =
      !auth.row.activated_at &&
      !auth.row.device_id &&
      (lifecycle === 'pending' || lifecycle === 'code_expired' || lifecycle === 'transfer_requested')
    return respond(isUnusedCode ? await cancelActivationCode(auth.ctx) : await removeDevice(auth.ctx))
  } catch (error) {
    console.error('[admin/devices] remove failed', error)
    return NextResponse.json({ error: 'Could not remove this device. Try again.' }, { status: 500 })
  }
}
