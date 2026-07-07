import { createServerSupabaseClient } from '@/lib/supabase/server'
import { getResend } from '@/lib/email/resend'

export async function notifyManagersInvoiceFailure(input: {
  restaurantId: string
  restaurantName: string
  invoiceRequestId: string
  orderId: string
  invoiceNumber: string | null
  failureReason: string
}): Promise<void> {
  const supabase = createServerSupabaseClient()

  const { data: managers, error: managersError } = await supabase
    .from('restaurant_users')
    .select('user_id, role')
    .eq('restaurant_id', input.restaurantId)
    .in('role', ['owner', 'manager'])

  if (managersError) {
    console.error('[invoices] failed to load managers for failure notification', managersError)
    return
  }

  const userIds = (managers ?? []).map((row) => String(row.user_id)).filter(Boolean)
  if (userIds.length === 0) return

  const { data: users, error: usersError } = await supabase
    .from('users')
    .select('email')
    .in('id', userIds)

  if (usersError) {
    console.error('[invoices] failed to load manager emails', usersError)
    return
  }

  const emails = [...new Set((users ?? []).map((row) => String(row.email || '').trim()).filter(Boolean))]
  if (emails.length === 0) return

  if (process.env.INVOICE_SKIP_EMAIL === 'true' || !process.env.RESEND_API_KEY) {
    console.info('[invoices] skip manager failure email (test mode)', {
      restaurantId: input.restaurantId,
      invoiceRequestId: input.invoiceRequestId,
      failureReason: input.failureReason,
    })
    return
  }

  try {
    const resend = getResend()
    await resend.emails.send({
      from: 'FlashTap Alerts <noreply@flashtap.app>',
      to: emails,
      subject: `Invoice generation failed — ${input.restaurantName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #37352F;">
          <h2 style="font-size: 18px; color: #C0392B;">Invoice generation failed</h2>
          <p>We could not generate or deliver a tax invoice after multiple attempts.</p>
          <ul style="font-size: 14px; line-height: 1.6;">
            <li><strong>Restaurant:</strong> ${input.restaurantName}</li>
            <li><strong>Order:</strong> ${input.orderId}</li>
            <li><strong>Invoice request:</strong> ${input.invoiceRequestId}</li>
            ${input.invoiceNumber ? `<li><strong>Invoice number:</strong> ${input.invoiceNumber}</li>` : ''}
          </ul>
          <p style="font-size: 13px; color: #6B675F;"><strong>Reason:</strong> ${input.failureReason}</p>
          <p style="font-size: 13px;">Please retry from the dashboard or contact support if the issue persists.</p>
        </div>
      `,
    })
  } catch (error) {
    console.error('[invoices] manager failure notification email failed', error)
  }
}
