import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/** Platform console entry — ops dashboard homepage. */
export default function AdminIndexPage() {
  redirect('/admin/dashboard')
}
