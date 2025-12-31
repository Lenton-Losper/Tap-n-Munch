import { redirect } from 'next/navigation'

export const dynamic = "force-dynamic"

/**
 * Cache-Busting Redirect: Old route redirects to new v2 route
 * This forces browsers to download fresh JavaScript and bypasses cache issues
 */
export default function MenuLandingPage({
  params,
  searchParams,
}: {
  params: { restaurantId: string }
  searchParams: { table?: string }
}) {
  const tableParam = searchParams.table ? `?table=${searchParams.table}` : ''
  redirect(`/menu/${params.restaurantId}/v2${tableParam}`)
}
