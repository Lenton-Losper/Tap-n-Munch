import { NextResponse } from 'next/server'
import {
  requirePlatformRole,
  resolvePlatformAdmin,
  writePlatformAudit,
} from '@/lib/permissions/assert-platform-admin'
import { attachRestaurantNames } from '@/lib/platform/attach-restaurant-names'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const BUG_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const
type BugStatus = (typeof BUG_STATUSES)[number]

function isBugStatus(value: string): value is BugStatus {
  return (BUG_STATUSES as readonly string[]).includes(value)
}

function hasStatusColumn(error: { message?: string; code?: string } | null | undefined) {
  const message = String(error?.message || '')
  return !(
    error?.code === '42703' ||
    /column .*status.* does not exist/i.test(message) ||
    /Could not find the .*column.*status/i.test(message)
  )
}

export async function GET(request: Request) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const status = new URL(request.url).searchParams.get('status')?.trim() || null
    if (status && !isBugStatus(status)) {
      return NextResponse.json({ error: 'Invalid bug report status.' }, { status: 400 })
    }

    const supabase = createServerSupabaseClient()
    // Avoid restaurants(name) embed: staging historically lacked the FK.
    let query = supabase.from('bug_reports').select('*').order('created_at', { ascending: false })

    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) {
      if (status && !hasStatusColumn(error)) {
        return NextResponse.json(
          {
            error:
              'Bug report status columns are not applied yet. Run migration 20260724180000_platform_ops_console.',
          },
          { status: 503 },
        )
      }
      throw error
    }

    const bugReports = await attachRestaurantNames(
      supabase,
      (data ?? []) as Array<Record<string, unknown>>,
    )

    return NextResponse.json({ bugReports })
  } catch (error) {
    console.error('[platform/bug-reports] GET', error)
    return NextResponse.json({ error: 'Failed to load bug reports.' }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  const admin = await requirePlatformRole(request, ['support', 'super_admin'])
  if (admin instanceof NextResponse) return admin

  try {
    const parsed: unknown = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'A JSON object is required.' }, { status: 400 })
    }

    const body = parsed as Record<string, unknown>
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const hasStatus = Object.prototype.hasOwnProperty.call(body, 'status')
    const hasInternalNote = Object.prototype.hasOwnProperty.call(body, 'internalNote')

    if (!id) {
      return NextResponse.json({ error: 'id is required.' }, { status: 400 })
    }
    if (!hasStatus && !hasInternalNote) {
      return NextResponse.json(
        { error: 'At least one of status or internalNote is required.' },
        { status: 400 },
      )
    }

    const updates: Record<string, string | null> = {}
    if (hasStatus) {
      if (typeof body.status !== 'string' || !isBugStatus(body.status)) {
        return NextResponse.json({ error: 'Invalid bug report status.' }, { status: 400 })
      }
      updates.status = body.status
      updates.resolved_at =
        body.status === 'resolved' || body.status === 'closed'
          ? new Date().toISOString()
          : null
    }

    if (hasInternalNote) {
      if (body.internalNote !== null && typeof body.internalNote !== 'string') {
        return NextResponse.json(
          { error: 'internalNote must be a string or null.' },
          { status: 400 },
        )
      }
      updates.internal_note =
        typeof body.internalNote === 'string' ? body.internalNote.trim() || null : null
    }

    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('bug_reports')
      .update(updates)
      .eq('id', id)
      .select('*')
      .maybeSingle()

    if (error) {
      if (!hasStatusColumn(error)) {
        return NextResponse.json(
          {
            error:
              'Bug report triage columns are not applied yet. Run migration 20260724180000_platform_ops_console.',
          },
          { status: 503 },
        )
      }
      throw error
    }
    if (!data) {
      return NextResponse.json({ error: 'Bug report not found.' }, { status: 404 })
    }

    const [bugReport] = await attachRestaurantNames(supabase, [
      data as Record<string, unknown>,
    ])

    await writePlatformAudit({
      actorId: admin.userId,
      actorEmail: admin.email,
      action: 'bug_report_updated',
      targetType: 'bug_report',
      targetId: id,
      payload: {
        ...(hasStatus ? { status: updates.status } : {}),
        ...(hasInternalNote ? { internalNote: updates.internal_note } : {}),
      },
      request,
    })

    return NextResponse.json({ bugReport })
  } catch (error) {
    console.error('[platform/bug-reports] PATCH', error)
    return NextResponse.json({ error: 'Failed to update bug report.' }, { status: 500 })
  }
}
