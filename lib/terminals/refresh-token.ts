import { createHash, randomBytes } from 'crypto'

export function generateRefreshToken(): string {
  return randomBytes(48).toString('hex')
}

export function hashRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('hex')
}

export function refreshTokenExpiresAt(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
}
