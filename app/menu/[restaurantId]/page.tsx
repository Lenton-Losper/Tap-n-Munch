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
  // Ensure restaurantId exists
  const restaurantId = params?.restaurantId || ''
  
  if (!restaurantId) {
    // If restaurantId is missing, redirect to error or home
    redirect('/')
  }
  
  // Build table parameter correctly
  const tableNumber = searchParams?.table || ''
  const tableParam = tableNumber ? `?table=${tableNumber}` : ''
  
  // Redirect to v2 route with exact path
  redirect(`/menu/${restaurantId}/v2${tableParam}`)
}
