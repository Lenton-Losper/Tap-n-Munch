const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomSegment(length: number): string {
  return Array.from(
    { length },
    () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  ).join('')
}

export function generateTerminalActivationCode(): string {
  return `FT-${randomSegment(4)}-${randomSegment(4)}`
}

/** Placeholder until the P5 activates with a real device id (column is NOT NULL in production). */
export function pendingTerminalDeviceId(): string {
  return `pending-${crypto.randomUUID()}`
}

export function normalizeActivationCode(value: string): string {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
}
