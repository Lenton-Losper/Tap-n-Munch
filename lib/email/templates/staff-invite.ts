import { getResend } from '@/lib/email/resend'

type StaffInviteEmailParams = {
  to: string
  restaurantName: string
  role: string
  inviteUrl: string
}

function formatRole(role: string): string {
  const normalized = role.trim().toLowerCase()
  if (normalized === 'manager') return 'Manager'
  if (normalized === 'waiter') return 'Waiter'
  return role
}

export async function sendStaffInviteEmail({
  to,
  restaurantName,
  role,
  inviteUrl,
}: StaffInviteEmailParams) {
  const displayRole = formatRole(role)

  const result = await getResend().emails.send({
    from: 'FlashTap <noreply@flashtap.app>',
    to: [to],
    subject: `You've been invited to join ${restaurantName} on FlashTap`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 24px; color: #37352F;">
        <h1 style="font-size: 22px; font-weight: 600; margin: 0 0 16px;">You're invited to FlashTap</h1>
        <p style="font-size: 15px; line-height: 1.6; margin: 0 0 24px;">
          You've been invited to join <strong>${restaurantName}</strong> as a <strong>${displayRole}</strong>.
          Click the button below to accept your invitation.
        </p>
        <a href="${inviteUrl}" style="display: inline-block; background: #37352F; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 15px; font-weight: 500;">
          Accept Invitation
        </a>
        <p style="font-size: 13px; line-height: 1.5; color: #6B675F; margin: 24px 0 0;">
          This link expires in 7 days. If you didn't expect this email, you can safely ignore it.
        </p>
      </div>
    `,
  })

  if (result.error) {
    const message =
      typeof result.error.message === 'string'
        ? result.error.message
        : 'Resend rejected the staff invite email'
    throw new Error(
      `Resend send failed (${result.error.name || 'error'}): ${message}`
    )
  }

  return result
}
