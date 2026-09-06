/**
 * ESC/POS BYTES AND THERMAL LAYOUT, SHARED BY EVERY DOCUMENT THIS ESTATE PRINTS.
 *
 * ================================================================================================
 * WHY THIS EXISTS
 * ================================================================================================
 *
 * These were private to escposRenderer.ts, which renders a receipt. The end-of-day cash-up is a
 * second thermal document on the same printers, and it needs the same builder, the same command
 * bytes and the same two-column layout. Copying them would leave two definitions of what ESC @
 * means and two implementations of "pad a label and a figure to the paper width" — and the day
 * they drift is the day a receipt and a cash-up printed from one device disagree about alignment,
 * or one of them stops cutting the paper.
 *
 * EXTRACTED WITHOUT CHANGING A BYTE. __tests__/escpos-renderer.test.ts carries a sha256 of the
 * rendered receipt at 32 and 48 columns, recorded BEFORE this module existed. It is the proof that
 * moving this code left the printed paper identical — the other tests in that file assert
 * properties, and a property test cannot see a changed command byte or a one-character shift in
 * padding.
 *
 * NOTHING HERE KNOWS WHAT IT IS PRINTING. No receipt shape, no report shape. That is the whole
 * point of the split: documents compose these, and these describe paper.
 */

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

/** 58mm paper at the default font. 80mm is 48; the caller passes what the printer is configured for. */
export const DEFAULT_CHARACTER_WIDTH = 32

export class EscposBuilder {
  private chunks: number[][] = []

  raw(bytes: number[]): this {
    this.chunks.push(bytes)
    return this
  }

  text(line: string): this {
    this.chunks.push(Array.from(Buffer.from(line, 'ascii')))
    return this
  }

  newline(): this {
    this.chunks.push([LF])
    return this
  }

  line(text = ''): this {
    return this.text(text).newline()
  }

  init(): this {
    return this.raw([ESC, 0x40])
  }

  align(mode: 'left' | 'center' | 'right'): this {
    const n = mode === 'left' ? 0 : mode === 'center' ? 1 : 2
    return this.raw([ESC, 0x61, n])
  }

  bold(on: boolean): this {
    return this.raw([ESC, 0x45, on ? 1 : 0])
  }

  feed(lines: number): this {
    return this.raw([ESC, 0x64, lines])
  }

  cut(): this {
    return this.raw([GS, 0x56, 0x01])
  }

  build(): Uint8Array {
    const bytes = this.chunks.flat()
    return Uint8Array.from(bytes)
  }
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, Math.max(0, maxLength - 1)) + '…'
}

/** Left-aligned label, right-aligned value, padded/truncated to fit characterWidth. */
export function twoColumnLine(left: string, right: string, characterWidth: number): string {
  const safeRight = truncate(right, characterWidth)
  const availableLeft = Math.max(0, characterWidth - safeRight.length - 1)
  const safeLeft = truncate(left, availableLeft)
  const padding = Math.max(1, characterWidth - safeLeft.length - safeRight.length)
  return safeLeft + ' '.repeat(padding) + safeRight
}

/**
 * Word-wrap to the paper width. Used for the customer's order note, which can run to 280
 * characters: truncating it at the column width would drop the customer's own words (an
 * allergy note is the obvious case), so it wraps instead. A single word longer than the
 * paper is hard-split rather than dropped.
 */
export function wrapToWidth(text: string, characterWidth: number): string[] {
  const lines: string[] = []
  let current = ''

  for (const word of text.trim().split(/\s+/)) {
    let remaining = word
    while (remaining.length > characterWidth) {
      if (current) {
        lines.push(current)
        current = ''
      }
      lines.push(remaining.slice(0, characterWidth))
      remaining = remaining.slice(characterWidth)
    }
    if (!remaining) continue
    const candidate = current ? `${current} ${remaining}` : remaining
    if (candidate.length <= characterWidth) {
      current = candidate
    } else {
      if (current) lines.push(current)
      current = remaining
    }
  }
  if (current) lines.push(current)
  return lines
}

export function centered(text: string, characterWidth: number): string {
  const safe = truncate(text, characterWidth)
  const padding = Math.max(0, Math.floor((characterWidth - safe.length) / 2))
  return ' '.repeat(padding) + safe
}

export function divider(characterWidth: number): string {
  return '-'.repeat(characterWidth)
}
