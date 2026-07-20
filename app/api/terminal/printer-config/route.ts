import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'

export const dynamic = 'force-dynamic'

const PURPOSE = 'CUSTOMER_RECEIPT' as const

// Must match the terminal_printer_configs_connection_type_check CHECK constraint.
const CONNECTION_TYPES = ['BLUETOOTH', 'BUILTIN'] as const
type ConnectionType = (typeof CONNECTION_TYPES)[number]
const DEFAULT_CONNECTION_TYPE: ConnectionType = 'BLUETOOTH'

type PrinterConfigBody = {
  connection_type?: unknown
  printer_name?: unknown
  printer_address?: unknown
  paper_width_mm?: unknown
  character_width?: unknown
}

function isConnectionType(value: unknown): value is ConnectionType {
  return typeof value === 'string' && (CONNECTION_TYPES as readonly string[]).includes(value)
}

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const { data: config, error } = await supabase
      .from('terminal_printer_configs')
      .select('*')
      .eq('terminal_id', terminal.terminalId)
      .eq('purpose', PURPOSE)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: 'Failed to load printer config' }, { status: 500 })
    }

    return NextResponse.json({ config: config ?? null })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/printer-config]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

export async function POST(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const body = (await req.json().catch(() => ({}))) as PrinterConfigBody

    let connectionType: ConnectionType = DEFAULT_CONNECTION_TYPE
    if (body.connection_type != null) {
      if (!isConnectionType(body.connection_type)) {
        return NextResponse.json(
          { error: `connection_type must be one of: ${CONNECTION_TYPES.join(', ')}` },
          { status: 400 },
        )
      }
      connectionType = body.connection_type
    }

    const printerName = String(body.printer_name ?? '').trim()
    if (!printerName) {
      return NextResponse.json({ error: 'printer_name is required' }, { status: 400 })
    }
    const printerAddress = String(body.printer_address ?? '').trim()
    if (!printerAddress) {
      return NextResponse.json({ error: 'printer_address is required' }, { status: 400 })
    }
    const paperWidthMm = Number(body.paper_width_mm)
    const characterWidth = body.character_width != null ? Number(body.character_width) : null

    // One CUSTOMER_RECEIPT config per terminal in this phase: update in place if a row
    // already exists for this device, insert otherwise. No DB-level unique constraint --
    // a single terminal being re-paired concurrently with itself isn't a realistic race,
    // this is a human physically pairing one printer on one device.
    const { data: existing, error: existingError } = await supabase
      .from('terminal_printer_configs')
      .select('id')
      .eq('terminal_id', terminal.terminalId)
      .eq('purpose', PURPOSE)
      .maybeSingle()

    if (existingError) {
      return NextResponse.json({ error: 'Failed to check existing printer config' }, { status: 500 })
    }

    const now = new Date().toISOString()

    if (existing) {
      const { data: updated, error: updateError } = await supabase
        .from('terminal_printer_configs')
        .update({
          connection_type: connectionType,
          printer_name: printerName,
          printer_address: printerAddress,
          paper_width_mm: Number.isFinite(paperWidthMm) && paperWidthMm > 0 ? paperWidthMm : 80,
          character_width: Number.isFinite(characterWidth) ? characterWidth : null,
          last_connected_at: now,
          updated_at: now,
        })
        .eq('id', existing.id)
        .select('*')
        .single()

      if (updateError || !updated) {
        return NextResponse.json({ error: 'Failed to update printer config' }, { status: 500 })
      }
      return NextResponse.json({ config: updated })
    }

    const { data: created, error: insertError } = await supabase
      .from('terminal_printer_configs')
      .insert({
        terminal_id: terminal.terminalId,
        purpose: PURPOSE,
        connection_type: connectionType,
        printer_name: printerName,
        printer_address: printerAddress,
        paper_width_mm: Number.isFinite(paperWidthMm) && paperWidthMm > 0 ? paperWidthMm : 80,
        character_width: Number.isFinite(characterWidth) ? characterWidth : null,
        last_connected_at: now,
      })
      .select('*')
      .single()

    if (insertError || !created) {
      return NextResponse.json({ error: 'Failed to create printer config' }, { status: 500 })
    }
    return NextResponse.json({ config: created })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/printer-config]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}

// "Forget this printer" (Settings UI). No client-writable RLS policy exists for this table
// (matches receipt_documents/receipt_deliveries) -- this route, running as the service role
// after terminal JWT verification, is the only thing that can remove a config row.
export async function DELETE(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const { error } = await supabase
      .from('terminal_printer_configs')
      .delete()
      .eq('terminal_id', terminal.terminalId)
      .eq('purpose', PURPOSE)

    if (error) {
      return NextResponse.json({ error: 'Failed to remove printer config' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    console.error('[terminal/printer-config]', err)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
