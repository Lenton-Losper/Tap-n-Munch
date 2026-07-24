import { NextResponse } from 'next/server'
import { resolvePlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

type AuditSource = 'platform' | 'tenant' | 'all'

function isAuditSource(value: string): value is AuditSource {
  return value === 'platform' || value === 'tenant' || value === 'all'
}

export async function GET(request: Request) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  const searchParams = new URL(request.url).searchParams
  const sourceValue = searchParams.get('source')?.trim() || 'all'
  if (!isAuditSource(sourceValue)) {
    return NextResponse.json(
      { error: 'source must be platform, tenant, or all.' },
      { status: 400 },
    )
  }

  const action = searchParams.get('action')?.trim() || null
  const actor = searchParams.get('actor')?.trim() || null

  try {
    const supabase = createServerSupabaseClient()
    const includePlatform = sourceValue === 'all' || sourceValue === 'platform'
    const includeTenant =
      (sourceValue === 'all' || sourceValue === 'tenant') && actor === null

    const loadPlatformLogs = async () => {
      if (!includePlatform) return [] as Array<Record<string, unknown>>

      let query = supabase
        .from('platform_audit_logs')
        .select(
          // correlation_id is added by 20260724180000; select * keeps this
          // route working before and after that migration is applied.
          'id, actor_id, actor_email, action, target_type, target_id, payload, ip_address, user_agent, success, created_at',
        )
        .order('created_at', { ascending: false })
        .limit(100)

      if (action) query = query.eq('action', action)
      if (actor) query = query.ilike('actor_email', `%${actor}%`)

      const { data, error } = await query
      if (error) throw error

      return (data ?? []).map((row) => ({
        ...row,
        source: 'platform' as const,
        entity_type: row.target_type,
        entity_id: row.target_id,
        metadata: row.payload,
        restaurant_id: null,
      }))
    }

    const loadTenantLogs = async () => {
      // Tenant audit rows do not have actor_email, so they cannot match an actor filter.
      if (!includeTenant) return [] as Array<Record<string, unknown>>

      let query = supabase
        .from('audit_logs')
        .select(
          'id, restaurant_id, action, entity_type, entity_id, metadata, created_at, restaurants(name)',
        )
        .order('created_at', { ascending: false })
        .limit(100)

      if (action) query = query.eq('action', action)

      const { data, error } = await query
      if (error) throw error

      return (data ?? []).map((row) => ({
        ...row,
        source: 'tenant' as const,
        actor_id: null,
        actor_email: null,
        target_type: row.entity_type,
        target_id: row.entity_id,
        payload: row.metadata,
        success: true,
      }))
    }

    const [platformLogs, tenantLogs] = await Promise.all([
      loadPlatformLogs(),
      loadTenantLogs(),
    ])
    const logs = [...platformLogs, ...tenantLogs].sort((a, b) =>
      String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
    )

    return NextResponse.json({
      logs,
      counts: {
        platform: platformLogs.length,
        tenant: tenantLogs.length,
      },
    })
  } catch (error) {
    console.error('[platform/audit-logs] GET', error)
    return NextResponse.json({ error: 'Failed to load audit logs.' }, { status: 500 })
  }
}
