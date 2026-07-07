import { after } from 'next/server'
import { processInvoiceRequest } from '@/lib/invoices/process-invoice-request'

const MAX_INLINE_RETRIES = 3

async function runWithRetries(invoiceRequestId: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_INLINE_RETRIES; attempt += 1) {
    try {
      await processInvoiceRequest(invoiceRequestId, { attempt })
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invoice generation failed'
      console.error('[invoices] generation attempt failed', {
        invoiceRequestId,
        attempt,
        error: message,
      })
      if (attempt === MAX_INLINE_RETRIES) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
}

/**
 * Non-blocking invoice generation. Uses Next.js `after()` so checkout/staff
 * API responses are not blocked. Swap for Cloudflare Queue dispatch here later.
 */
export function scheduleInvoiceGeneration(invoiceRequestId: string): void {
  const trimmed = String(invoiceRequestId || '').trim()
  if (!trimmed) return

  try {
    after(async () => {
      try {
        await runWithRetries(trimmed)
      } catch (error) {
        console.error('[invoices] generation exhausted retries', {
          invoiceRequestId: trimmed,
          error,
        })
      }
    })
  } catch {
    void runWithRetries(trimmed).catch((error) => {
      console.error('[invoices] direct generation failed (no after() context)', {
        invoiceRequestId: trimmed,
        error,
      })
    })
  }
}

/** For scripts/tests — runs synchronously with retries. */
export async function runInvoiceGenerationNow(invoiceRequestId: string): Promise<void> {
  await runWithRetries(invoiceRequestId)
}
