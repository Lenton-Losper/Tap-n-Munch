import { SignJWT } from 'jose'

export const TERMINAL_JWT_PERMISSIONS = [
  'orders:read',
  'orders:update',
  'tables:read',
] as const

export async function signTerminalJwt(payload: {
  terminal_id: string
  restaurant_id: string
  device_serial: string
}) {
  const secretValue = process.env.TERMINAL_JWT_SECRET
  if (!secretValue) {
    throw new Error('TERMINAL_JWT_SECRET is not configured')
  }

  const secret = new TextEncoder().encode(secretValue)

  return new SignJWT({
    type: 'terminal',
    restaurant_id: payload.restaurant_id,
    device_serial: payload.device_serial,
    permissions: [...TERMINAL_JWT_PERMISSIONS],
  })
    .setSubject(payload.terminal_id)
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(secret)
}
