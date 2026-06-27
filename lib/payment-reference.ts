export function generatePaymentReference(): string {
  const date = new Date()
  const dateStr = date.toISOString().slice(0, 10).replace(/-/g, '')
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let random = ''
  for (let i = 0; i < 8; i++) {
    random += chars[Math.floor(Math.random() * chars.length)]
  }
  return `PAY-${dateStr}-${random}`
}
