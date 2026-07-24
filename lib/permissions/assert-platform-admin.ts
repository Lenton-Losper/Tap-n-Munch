import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/supabase/admin-restaurant-auth'
import { NextResponse } from 'next/server'

export type PlatformAdminRole = 'super_admin' | 'support'

export type PlatformAdminContext = {
  userId: string
  email: string
  role: PlatformAdminRole
}

/**
 * Membership check only (any platform_admins row). Returns an error response or null.
 */
export async function assertPlatformAdmin(request: Request): Promise<NextResponse | null> {
  const result = await resolvePlatformAdmin(request)
  if (result instanceof NextResponse) return result
  return null
}

/**
 * Resolve the calling platform admin. Returns NextResponse on failure.
 */
export async function resolvePlatformAdmin(
  request: Request,
): Promise<PlatformAdminContext | NextResponse> {
  try {
    const user = await getUserFromRequest(request)
    const supabase = createServerSupabaseClient()
    const { data: row, error } = await supabase
      .from('platform_admins')
      .select('role, email')
      .eq('user_id', user.id)
      .maybeSingle()

    if (error) throw error
    if (!row) {
      return NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 })
    }

    const role = String(row.role || 'support') as PlatformAdminRole
    if (role !== 'super_admin' && role !== 'support') {
      return NextResponse.json({ error: 'Platform admin access required.' }, { status: 403 })
    }

    return {
      userId: user.id,
      email: String(row.email || user.email || ''),
      role,
    }
  } catch {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
  }
}

/**
 * Require a minimum role. support < super_admin.
 * support can call with ['support','super_admin']; mutate endpoints use ['super_admin'].
 */
export async function requirePlatformRole(
  request: Request,
  allowed: PlatformAdminRole[],
): Promise<PlatformAdminContext | NextResponse> {
  const resolved = await resolvePlatformAdmin(request)
  if (resolved instanceof NextResponse) return resolved
  if (!allowed.includes(resolved.role)) {
    return NextResponse.json(
      { error: 'Insufficient platform role for this action.' },
      { status: 403 },
    )
  }
  return resolved
}

export function clientIp(request: Request): string | null {
  return request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? null
}

export async function writePlatformAudit(params: {
  actorId: string
  actorEmail: string
  action: string
  targetType: string
  targetId?: string | null
  payload?: Record<string, unknown> | null
  request: Request
  success?: boolean
  correlationId?: string | null
}) {
  const supabase = createServerSupabaseClient()
  await supabase.from('platform_audit_logs').insert({
    actor_id: params.actorId,
    actor_email: params.actorEmail,
    action: params.action,
    target_type: params.targetType,
    target_id: params.targetId ?? null,
    payload: params.payload ?? null,
    ip_address: clientIp(params.request),
    user_agent: params.request.headers.get('user-agent') ?? null,
    success: params.success ?? true,
    correlation_id: params.correlationId ?? null,
  })
}
