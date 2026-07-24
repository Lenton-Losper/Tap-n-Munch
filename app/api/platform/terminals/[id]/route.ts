import { NextResponse } from 'next/server'
import { resolvePlatformAdmin } from '@/lib/permissions/assert-platform-admin'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { DASHBOARD_POLL_INTERVAL_MS, TERMINAL_OFFLINE_MS } from '@/lib/platform/dashboard'

export const dynamic = 'force-dynamic'

function freshness(lastSeenAt: string | null | undefined): 'fresh' | 'stale' | 'never' {
  if (!lastSeenAt) return 'never'
  const age = Date.now() - new Date(lastSeenAt).getTime()
  if (!Number.isFinite(age)) return 'never'
  if (age <= TERMINAL_OFFLINE_MS) return 'fresh'
  return 'stale'
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await resolvePlatformAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    const { id } = await params
    const supabase = createServerSupabaseClient()
    const generatedAt = new Date().toISOString()
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from('restaurant_terminals')
      .select(
        'id, restaurant_id, device_id, sn, device_serial, terminal_name, name, model, app_version, last_seen_at, status, active, activated_at, created_at, activation_code_expires_at, refresh_token_expires_at, expires_at, restaurants(name)',
      )
      .eq('id', id)
      .maybeSingle()

    if (error) throw error
    if (!data) {
      return NextResponse.json({ error: 'Terminal not found.' }, { status: 404 })
    }

    const lastSeen = data.last_seen_at ? new Date(data.last_seen_at).getTime() : Number.NaN
    const ageMs = Number.isFinite(lastSeen) ? Date.now() - lastSeen : null
    const online = Number.isFinite(lastSeen) && lastSeen >= Date.now() - TERMINAL_OFFLINE_MS
    const restRel = data.restaurants as { name?: string } | { name?: string }[] | null
    const restaurantName = Array.isArray(restRel) ? restRel[0]?.name : restRel?.name

    const [{ data: paymentEvents }, { data: printerConfig }, { data: receiptFails }] =
      await Promise.all([
        supabase
          .from('payment_events')
          .select(
            'id, event_type, amount, currency, business_order_no, transaction_id, gateway_result_code, gateway_result_message, reason_code, created_at, app_version',
          )
          .eq('terminal_id', id)
          .gte('created_at', dayAgo)
          .order('created_at', { ascending: false })
          .limit(25),
        supabase
          .from('terminal_printer_configs')
          .select(
            'terminal_id, updated_at, connection_type, printer_name, purpose, is_default, last_connected_at',
          )
          .eq('terminal_id', id)
          .maybeSingle(),
        supabase
          .from('audit_logs')
          .select('id, action, created_at, metadata')
          .eq('restaurant_id', data.restaurant_id)
          .eq('action', 'receipt.issuance_failed')
          .gte('created_at', dayAgo)
          .order('created_at', { ascending: false })
          .limit(10),
      ])

    const events = paymentEvents ?? []
    const failedPayments = events.filter((e) => {
      const type = String(e.event_type || '').toLowerCase()
      const code = String(e.gateway_result_code || '')
      return type.includes('fail') || type.includes('error') || (code && code !== '0' && code !== '00')
    })

    return NextResponse.json({
      meta: {
        generatedAt,
        pollIntervalMs: DASHBOARD_POLL_INTERVAL_MS,
      },
      terminal: {
        ...data,
        restaurant_name: restaurantName ?? null,
        online,
      },
      telemetry: {
        connectivity: {
          online,
          lastSeenAt: data.last_seen_at,
          ageMs,
          heartbeatWindowMs: TERMINAL_OFFLINE_MS,
          freshness: freshness(data.last_seen_at),
        },
        identity: {
          deviceId: data.device_id,
          sn: data.sn,
          deviceSerial: data.device_serial,
          model: data.model,
          appVersion: data.app_version,
          terminalName: data.terminal_name || data.name,
        },
        session: {
          status: data.status,
          active: data.active,
          activatedAt: data.activated_at,
          createdAt: data.created_at,
          refreshTokenExpiresAt: data.refresh_token_expires_at,
          expiresAt: data.expires_at,
          activationCodeExpiresAt: data.activation_code_expires_at,
        },
        payments24h: {
          eventCount: events.length,
          failedCount: failedPayments.length,
          lastEventAt: events[0]?.created_at ?? null,
          events: events.slice(0, 12),
        },
        printer: printerConfig
          ? {
              configured: true,
              connectionType: printerConfig.connection_type ?? null,
              printerName: printerConfig.printer_name ?? null,
              purpose: printerConfig.purpose ?? null,
              isDefault: Boolean(printerConfig.is_default),
              lastConnectedAt: printerConfig.last_connected_at ?? null,
              updatedAt: printerConfig.updated_at ?? null,
            }
          : {
              configured: false,
              connectionType: null,
              printerName: null,
              purpose: null,
              isDefault: false,
              lastConnectedAt: null,
              updatedAt: null,
            },
        receipts24h: {
          issuanceFailures: (receiptFails ?? []).length,
          recent: (receiptFails ?? []).slice(0, 5),
        },
      },
      remoteActions: {
        restart: false,
        pushApk: false,
        sync: false,
      },
      note: 'Remote terminal actions are deferred. Telemetry is derived from heartbeats, payment_events, and printer config.',
    })
  } catch (error) {
    console.error('[platform/terminals/[id]] GET', error)
    return NextResponse.json({ error: 'Failed to load terminal.' }, { status: 500 })
  }
}
