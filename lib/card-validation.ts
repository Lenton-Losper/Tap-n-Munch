/**
 * Client-side card validation for checkout (no PAN storage).
 */

export function normalizeCardDigits(display: string): string {
  return display.replace(/\D/g, '')
}

/** Groups digits as 4-4-4-4… for display (max 19 digits). */
export function formatCardNumberInput(rawInput: string): string {
  const d = rawInput.replace(/\D/g, '').slice(0, 19)
  const parts: string[] = []
  for (let i = 0; i < d.length; i += 4) {
    parts.push(d.slice(i, i + 4))
  }
  return parts.join(' ')
}

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i]!, 10)
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

/** Returns error message or null if valid. */
export function validateCardNumberDigits(digits: string): string | null {
  if (digits.length < 13 || digits.length > 19) return 'Invalid card number'
  if (!luhnValid(digits)) return 'Invalid card number'
  return null
}

export function validateCardholderName(raw: string): string | null {
  const name = raw.trim()
  if (name.length < 2) return 'Enter at least 2 characters'
  if (!/^[a-zA-Z ]+$/.test(name)) return 'Letters and spaces only'
  return null
}

/** Parse MM/YY; returns error or null if valid and not expired. */
export function validateExpiryMmYy(value: string): string | null {
  const trimmed = value.trim()
  const m = trimmed.match(/^(\d{2})\/(\d{2})$/)
  if (!m) return 'Use MM/YY format'
  const mm = parseInt(m[1]!, 10)
  const yy = parseInt(m[2]!, 10)
  if (mm < 1 || mm > 12) return 'Invalid month'
  const year = 2000 + yy
  const now = new Date()
  const curY = now.getFullYear()
  const curM = now.getMonth() + 1
  if (year < curY || (year === curY && mm < curM)) return 'Card has expired'
  return null
}

export function expectedCvvLength(cardDigits: string): number {
  const d = cardDigits.replace(/\D/g, '')
  if (d.length >= 2 && (d.startsWith('34') || d.startsWith('37'))) return 4
  return 3
}

export function validateCvv(cvvRaw: string, cardDigits: string): string | null {
  const cvv = cvvRaw.trim()
  if (!cvv) return 'Enter CVV'
  if (!/^\d+$/.test(cvv)) return 'CVV must contain only numbers'
  const len = expectedCvvLength(cardDigits)
  if (cvv.length !== len) {
    return len === 4
      ? 'American Express requires a 4-digit CVV'
      : 'CVV must be 3 digits for this card'
  }
  return null
}

/** Format user input as MM/YY with slash after month. */
export function formatExpiryMmYyInput(prev: string, next: string): string {
  const digits = next.replace(/\D/g, '').slice(0, 4)
  if (digits.length <= 2) return digits
  return `${digits.slice(0, 2)}/${digits.slice(2)}`
}
