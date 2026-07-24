import { NextResponse } from 'next/server'
import {
  requirePlatformRole,
  resolvePlatformAdmin,
  writePlatformAudit,
} from '@/lib/permissions/assert-platform-admin'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const BUG_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const
type BugStatus = (typeof BUG_STATUSES)[number]

function isBugStatus(value: string): value is BugStatus {
  return (BUG_STATUSES as readonly string[]).includes(value)
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
    let query = supabase
      .from('bug_reports')
      .select('*, restaurants(name)')
      .order('created_at', { ascending: false })

    if (status) query = query.eq('status', status)

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ bugReports: data ?? [] })
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
      .select('*, restaurants(name)')
      .maybeSingle()

    if (error) throw error
    if (!data) {
      return NextResponse.json({ error: 'Bug report not found.' }, { status: 404 })
    }

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

    return NextResponse.json({ bugReport: data })
  } catch (error) {
    console.error('[platform/bug-reports] PATCH', error)
    return NextResponse.json({ error: 'Failed to update bug report.' }, { status: 500 })
  }
}
