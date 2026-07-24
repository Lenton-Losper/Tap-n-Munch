import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/** Platform console entry — real home is the restaurants list. */
export default function AdminIndexPage() {
  redirect('/admin/restaurants')
}
