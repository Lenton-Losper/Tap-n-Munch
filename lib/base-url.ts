/**
 * Centralized base URL management for the application
 * 
 * This ensures QR codes and links always point to the production domain,
 * never to preview deployments or localhost.
 * 
 * IMPORTANT: Set NEXT_PUBLIC_BASE_URL in Vercel environment variables
 * to your production domain (e.g., https://your-app.vercel.app)
 */

/**
 * Get the base URL for the application
 * 
 * Priority:
 * 1. NEXT_PUBLIC_BASE_URL (set in Vercel env vars) - Always use in production
 * 2. window.location.origin (client-side fallback)
 * 3. Empty string (server-side fallback)
 * 
 * @param forceProduction - If true, will throw error if NEXT_PUBLIC_BASE_URL is not set in production
 * @returns Base URL string
 */
export function getBaseUrl(forceProduction: boolean = false): string {
  // Server-side: Use environment variable
  if (typeof window === 'undefined') {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || ''
    
    // In production, warn if base URL is not set
    if (forceProduction && process.env.NODE_ENV === 'production' && !baseUrl) {
      console.error(
        '⚠️ NEXT_PUBLIC_BASE_URL is not set in production! ' +
        'QR codes may point to incorrect URLs. ' +
        'Set NEXT_PUBLIC_BASE_URL in Vercel environment variables.'
      )
    }
    
    return baseUrl
  }
  
  // Client-side: Prefer environment variable, fallback to window.location.origin
  const envBaseUrl = process.env.NEXT_PUBLIC_BASE_URL
  if (envBaseUrl) {
    return envBaseUrl
  }
  
  // Fallback to current origin (for development or if env var not set)
  return window.location.origin
}

/**
 * Get the base URL for QR codes (always production)
 * 
 * This should be used when generating QR codes to ensure they always
 * point to the production domain, not preview deployments.
 * 
 * @returns Base URL string, throws error if not set in production
 */
export function getQRCodeBaseUrl(): string {
  const baseUrl = getBaseUrl(true)
  
  if (!baseUrl && process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_BASE_URL must be set in production for QR code generation. ' +
      'Set it in Vercel environment variables to your production domain.'
    )
  }
  
  return baseUrl || (typeof window !== 'undefined' ? window.location.origin : '')
}

/**
 * Build a menu URL for a restaurant
 * 
 * @param restaurantId - Restaurant ID
 * @param tableNumber - Optional table number
 * @returns Full menu URL
 */
export function buildMenuUrl(restaurantId: string, tableNumber?: number): string {
  const baseUrl = getQRCodeBaseUrl()
  const tableParam = tableNumber ? `?table=${tableNumber}` : ''
  return `${baseUrl}/menu/${restaurantId}${tableParam}`
}













