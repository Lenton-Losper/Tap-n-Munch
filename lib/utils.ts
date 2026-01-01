import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Helper function to convert Firestore Timestamp to Date
 */
function convertTimestamp(timestamp: any): Date | null {
  if (!timestamp) return null
  
  // If it's already a Date, return it
  if (timestamp instanceof Date) return timestamp
  
  // If it's a Firestore Timestamp, convert it
  if (timestamp && typeof timestamp.toDate === 'function') {
    return timestamp.toDate()
  }
  
  // If it's a string, try to parse it
  if (typeof timestamp === 'string') {
    const parsed = new Date(timestamp)
    return isNaN(parsed.getTime()) ? null : parsed
  }
  
  // If it's a number (milliseconds), create Date from it
  if (typeof timestamp === 'number') {
    return new Date(timestamp)
  }
  
  return null
}

/**
 * Normalize order data to ensure all required fields exist with safe defaults.
 * This prevents crashes when orders have missing or malformed data from old schemas.
 * 
 * @param data - Raw order data from Firestore
 * @returns Normalized order object with guaranteed safe array fields
 */
export function normalizeOrder(data: any) {
  if (!data || typeof data !== 'object') {
    return data
  }

  return {
    ...data,
    // Ensure items is always an array
    items: Array.isArray(data.items)
      ? data.items.map((item: any) => ({
          ...item,
          // Ensure addons is always an array (handle both old and new field names)
          addons: Array.isArray(item.addons) ? item.addons : [],
          selected_addons: Array.isArray(item.selected_addons) ? item.selected_addons : [],
          // Ensure modifiers is always an array (if it exists)
          modifiers: Array.isArray(item.modifiers) ? item.modifiers : [],
          // Ensure selected_size is null or an object
          selected_size: item.selected_size && typeof item.selected_size === 'object' 
            ? item.selected_size 
            : null,
          // Ensure special_instructions is a string or empty
          special_instructions: typeof item.special_instructions === 'string' 
            ? item.special_instructions 
            : '',
          // Ensure quantity is a number
          quantity: typeof item.quantity === 'number' && item.quantity > 0 
            ? item.quantity 
            : 1,
          // Ensure name is a string
          name: typeof item.name === 'string' ? item.name : 'Unknown Item',
          // Ensure base_price is a number
          base_price: typeof item.base_price === 'number' ? item.base_price : 0,
          // Ensure subtotal is a number
          subtotal: typeof item.subtotal === 'number' ? item.subtotal : 0,
        }))
      : [],
    // Ensure customer object exists with safe defaults
    customer: data.customer && typeof data.customer === 'object'
      ? {
          name: typeof data.customer.name === 'string' ? data.customer.name : '',
          phone: typeof data.customer.phone === 'string' ? data.customer.phone : '',
        }
      : null,
    // Ensure order_instructions is a string or null
    order_instructions: typeof data.order_instructions === 'string' && data.order_instructions.trim()
      ? data.order_instructions.trim()
      : null,
    // Ensure numeric fields have safe defaults
    table_number: typeof data.table_number === 'number' ? data.table_number : 0,
    order_number: typeof data.order_number === 'number' ? data.order_number : 0,
    subtotal: typeof data.subtotal === 'number' ? data.subtotal : 0,
    tax: typeof data.tax === 'number' ? data.tax : 0,
    total: typeof data.total === 'number' ? data.total : 0,
    // Convert Firestore Timestamps to Date objects for all timestamp fields
    placed_at: convertTimestamp(data.placed_at),
    accepted_at: convertTimestamp(data.accepted_at),
    preparing_at: convertTimestamp(data.preparing_at),
    ready_at: convertTimestamp(data.ready_at),
    completed_at: convertTimestamp(data.completed_at),
    cancelled_at: convertTimestamp(data.cancelled_at),
    paid_at: convertTimestamp(data.paid_at),
    created_at: convertTimestamp(data.created_at),
    updated_at: convertTimestamp(data.updated_at),
  }
}