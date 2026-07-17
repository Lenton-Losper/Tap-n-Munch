// TEMPORARY DIAGNOSTIC ROUTE -- delete once the WhatsApp outbound-send issue this is
// investigating is resolved. Sends a message directly to Meta's Graph API, bypassing
// n8n entirely, so the raw Meta response can be inspected without going through n8n's
// own workflow logic.
//
// Guarded by the X-Diagnostic-Token header (DIAGNOSTIC_ENDPOINT_TOKEN secret) rather
// than left fully open: this sends real outbound WhatsApp messages via the real Meta
// system-user token to any `to` number the caller supplies, on a publicly reachable
// staging URL with no rate limiting -- an open route here is a real spam/abuse vector
// against Riviera's actual WhatsApp Business identity.
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const GRAPH_API_VERSION = 'v21.0'

type SendTestBody = {
  phone_number_id?: string
  to?: string
  message_type?: 'text' | 'catalog'
  text_body?: string
}

function buildMetaPayload(body: SendTestBody): Record<string, unknown> {
  if (body.message_type === 'catalog') {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: body.to,
      type: 'interactive',
      interactive: {
        type: 'catalog_message',
        body: { text: 'Welcome! Browse our menu:' },
        action: { name: 'catalog_message' },
      },
    }
  }
  return {
    messaging_product: 'whatsapp',
    to: body.to,
    type: 'text',
    text: { body: body.text_body },
  }
}

export async function POST(request: Request) {
  const diagnosticToken = request.headers.get('x-diagnostic-token')
  const expectedDiagnosticToken = process.env.DIAGNOSTIC_ENDPOINT_TOKEN
  if (!expectedDiagnosticToken || diagnosticToken !== expectedDiagnosticToken) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: SendTestBody
  try {
    body = (await request.json()) as SendTestBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.phone_number_id || !body.to || !body.message_type) {
    return NextResponse.json(
      { error: 'phone_number_id, to, and message_type are required' },
      { status: 400 },
    )
  }
  if (body.message_type === 'text' && !body.text_body) {
    return NextResponse.json(
      { error: 'text_body is required when message_type is "text"' },
      { status: 400 },
    )
  }

  const systemUserToken = process.env.WHATSAPP_SYSTEM_USER_TOKEN
  if (!systemUserToken) {
    return NextResponse.json({ error: 'WHATSAPP_SYSTEM_USER_TOKEN is not configured' }, { status: 500 })
  }

  const metaUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${body.phone_number_id}/messages`
  const metaPayload = buildMetaPayload(body)
  const metaRequestHeaders = {
    Authorization: 'Bearer <redacted>',
    'Content-Type': 'application/json',
  }

  console.log('[send-test] outgoing request', {
    url: metaUrl,
    headers: metaRequestHeaders,
    body: metaPayload,
  })

  const metaResponse = await fetch(metaUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${systemUserToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(metaPayload),
  })

  const metaResponseBody = await metaResponse.text()

  console.log('[send-test] raw Meta response', {
    status: metaResponse.status,
    body: metaResponseBody,
  })

  return new NextResponse(metaResponseBody, {
    status: metaResponse.status,
    headers: {
      'Content-Type': metaResponse.headers.get('content-type') ?? 'application/json',
    },
  })
}
