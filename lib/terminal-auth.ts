import { jwtVerify } from 'jose'

const secret = new TextEncoder().encode(
  process.env.TERMINAL_JWT_SECRET!
)

export async function requireTerminalAuth(req: Request) {
  const auth = req.headers.get('authorization')
  if (!auth?.startsWith('Bearer ')) {
    throw new Response(
      JSON.stringify({ error: 'Missing terminal token' }),
      { status: 401 }
    )
  }
  const token = auth.replace('Bearer ', '')
  const { payload } = await jwtVerify(token, secret)
  if (payload.type !== 'terminal') {
    throw new Response(
      JSON.stringify({ error: 'Invalid token type' }),
      { status: 403 }
    )
  }
  return {
    terminalId: String(payload.sub),
    restaurantId: String(payload.restaurant_id),
    deviceSerial: String(payload.device_serial),
    permissions: (payload.permissions as string[]) || [],
  }
}

export async function validateTerminalRecord(
  supabase: any,
  terminal: any
) {
  const { data, error } = await supabase
    .from('restaurant_terminals')
    .select('id, status, restaurant_id, device_serial')
    .eq('id', terminal.terminalId)
    .eq('restaurant_id', terminal.restaurantId)
    .single()

  if (error || !data) {
    throw new Response(
      JSON.stringify({ error: 'Terminal not recognized' }),
      { status: 401 }
    )
  }
  if (data.status !== 'active') {
    throw new Response(
      JSON.stringify({ error: 'Terminal is not active' }),
      { status: 403 }
    )
  }
  return data
}
