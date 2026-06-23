import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { requireTerminalAuth, validateTerminalRecord } from '@/lib/terminal-auth'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: Request) {
  try {
    const terminal = await requireTerminalAuth(req)
    const supabase = createServerSupabaseClient()
    await validateTerminalRecord(supabase, terminal)

    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode('event: connected\ndata: {"status":"connected"}\n\n')
        )

        const channel = supabase
          .channel(`terminal-${terminal.terminalId}`)
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'orders',
              filter: `restaurant_id=eq.${terminal.restaurantId}`,
            },
            (payload) => {
              const event =
                payload.eventType === 'INSERT' ? 'order.created' : 'order.updated'

              const row = (payload.new || payload.old) as Record<string, unknown> | undefined
              const data = JSON.stringify({
                orderId: row?.id,
                tableNumber: row?.table_number,
                status: row?.status,
              })

              try {
                controller.enqueue(
                  encoder.encode(`event: ${event}\ndata: ${data}\n\n`)
                )
              } catch {
                channel.unsubscribe()
              }
            }
          )
          .subscribe()

        const pingInterval = setInterval(() => {
          try {
            controller.enqueue(
              encoder.encode(`event: ping\ndata: {"t":${Date.now()}}\n\n`)
            )
          } catch {
            clearInterval(pingInterval)
            channel.unsubscribe()
          }
        }, 25000)

        req.signal.addEventListener('abort', () => {
          clearInterval(pingInterval)
          channel.unsubscribe()
          controller.close()
        })
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  } catch (err: unknown) {
    if (err instanceof Response) return err
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
}
