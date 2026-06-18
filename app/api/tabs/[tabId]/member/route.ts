import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ tabId: string }> }
) {
  const { tabId } = await params
  const { sessionId, displayName } = await req.json()

  if (!sessionId || !displayName?.trim()) {
    return NextResponse.json({ error: 'Missing sessionId or displayName' }, { status: 400 })
  }

  const supabase = createServerSupabaseClient()

  const { data: tab } = await supabase
    .from('tabs')
    .select('id, members')
    .eq('id', tabId)
    .single()

  if (!tab) return NextResponse.json({ error: 'Tab not found' }, { status: 404 })

  const updatedMembers = (tab.members || []).map((m: any) =>
    m.session_id === sessionId
      ? { ...m, display_name: displayName.trim() }
      : m
  )

  const { error: updateError } = await supabase
    .from('tabs')
    .update({ members: updatedMembers })
    .eq('id', tabId)

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
