export function generateRefreshToken(): string {
  const bytes = new Uint8Array(48)
  crypto.getRandomValues(bytes)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function hashRefreshToken(refreshToken: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(refreshToken)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

export function refreshTokenExpiresAt(): string {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
}
