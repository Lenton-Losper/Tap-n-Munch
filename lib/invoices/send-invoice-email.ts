import { getResend } from '@/lib/email/resend'

export async function sendInvoiceEmail(input: {
  to: string
  restaurantName: string
  invoiceNumber: string
  pdfBytes: Uint8Array
}): Promise<{ id: string } | null> {
  if (process.env.INVOICE_SKIP_EMAIL === 'true') {
    console.info('[invoices] skip email (test mode)', {
      to: input.to,
      invoiceNumber: input.invoiceNumber,
      bytes: input.pdfBytes.length,
    })
    return null
  }

  const resend = getResend()
  const filename = `${input.invoiceNumber.replace(/[^a-zA-Z0-9-]/g, '_')}.pdf`

  const result = await resend.emails.send({
    from: 'FlashTap Invoices <noreply@flashtap.app>',
    to: [input.to],
    subject: `Tax Invoice ${input.invoiceNumber} — ${input.restaurantName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #37352F;">
        <h2 style="font-size: 20px;">Your tax invoice</h2>
        <p>Please find attached tax invoice <strong>${input.invoiceNumber}</strong> from <strong>${input.restaurantName}</strong>.</p>
        <p style="color: #6B675F; font-size: 13px;">This order was paid in full at the terminal.</p>
      </div>
    `,
    attachments: [
      {
        filename,
        content: Buffer.from(input.pdfBytes).toString('base64'),
      },
    ],
  })

  if (result.error) {
    throw new Error(result.error.message || 'Resend failed to send invoice email')
  }

  return result.data
}
