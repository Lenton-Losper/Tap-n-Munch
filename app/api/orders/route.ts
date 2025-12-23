import { db } from '@/lib/firebase/config'
import { collection, addDoc } from 'firebase/firestore'
import { NextResponse } from 'next/server'
import { getNextOrderNumber } from '@/lib/firebase/orders'

/**
 * STEP 2 & 3: HARDENED ORDER CREATION
 * 
 * Requirements:
 * - Accepts only REQUIRED fields
 * - Ignores everything else
 * - Removes ALL undefined values
 * - Removes ALL customer fields (customer_email, customer_name, customer_phone)
 * - Logs sanitized payload before writing
 * - Throws error if undefined detected
 */
export async function POST(req: Request) {
  try {
    const body = await req.json()
    
    // DEBUG: Log incoming request
    console.log('🔵 API ROUTE - Incoming request body keys:', Object.keys(body))
    console.log('🔵 API ROUTE - Has customer_email in body?', 'customer_email' in body)
    if ('customer_email' in body) {
      console.log('🔵 API ROUTE - customer_email value:', body.customer_email)
    }

    // Validation: Required fields
    if (!body.restaurantId || typeof body.restaurantId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid restaurantId' },
        { status: 400 }
      )
    }

    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json(
        { error: 'Missing or invalid items array' },
        { status: 400 }
      )
    }

    if (typeof body.total !== 'number' || body.total <= 0) {
      return NextResponse.json(
        { error: 'Missing or invalid total' },
        { status: 400 }
      )
    }

    // Get next order number
    const orderNumber = await getNextOrderNumber(body.restaurantId)

    // Clean items array - ONLY required fields
    const cleanItems = body.items.map((item: any) => {
      const cleanItem: Record<string, any> = {
        menu_item_id: String(item.menuItemId || item.menu_item_id || ''),
        name: String(item.name || ''),
        quantity: Number(item.quantity) || 1,
        base_price: Number(item.basePrice || item.base_price || 0),
        subtotal: Number(item.subtotal) || 0,
        special_instructions: String(item.specialInstructions || item.special_instructions || ''),
        selected_size: item.size || item.selected_size ? {
          name: String(item.size || item.selected_size?.name || ''),
          price_modifier: Number(item.selected_size?.price_modifier || 0),
        } : null,
        selected_addons: Array.isArray(item.addons) 
          ? item.addons.map((addon: any) => ({
              name: String(addon.name || ''),
              price: Number(addon.price || 0),
            }))
          : (Array.isArray(item.selected_addons) 
              ? item.selected_addons.map((addon: any) => ({
                  name: String(addon.name || ''),
                  price: Number(addon.price || 0),
                }))
              : []),
      }

      // Remove undefined values from item
      const finalItem = Object.fromEntries(
        Object.entries(cleanItem).filter(([_, v]) => v !== undefined)
      )

      // CRITICAL: Verify no undefined
      if (Object.values(finalItem).some(v => v === undefined)) {
        throw new Error('Order item contains undefined values')
      }

      return finalItem
    })

    // Build order data - ONLY required fields
    const orderData: Record<string, any> = {
      restaurant_id: String(body.restaurantId),
      table_number: Number(body.tableNumber || body.table_number) || 0,
      order_number: Number(orderNumber),
      items: cleanItems,
      subtotal: Number(body.subtotal) || 0,
      tax: Number(body.tax) || 0,
      service_fee: Number(body.service_fee) || 0,
      discount: Number(body.discount) || 0,
      tip: Number(body.tip) || 0,
      total: Number(body.total),
      status: 'new',
      payment_status: 'pending',
      payment_method: String(body.paymentMethod || body.payment_method || 'cash'),
      placed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // Optional: order_instructions (only if provided)
    if (body.notes || body.order_instructions) {
      const notes = String(body.notes || body.order_instructions || '').trim()
      if (notes) {
        orderData.order_instructions = notes
      }
    }

    // CRITICAL: Deep clean - recursively remove undefined and forbidden fields
    function deepClean(obj: any, depth = 0): any {
      if (depth > 10) return obj // Prevent infinite recursion
      if (obj === null || obj === undefined) return null
      if (typeof obj !== 'object') return obj
      
      if (Array.isArray(obj)) {
        return obj.map(item => deepClean(item, depth + 1))
      }
      
      const cleaned: Record<string, any> = {}
      const forbiddenFields = ['customer_email', 'customer_name', 'customer_phone']
      
      for (const [key, value] of Object.entries(obj)) {
        // Skip forbidden fields
        if (forbiddenFields.includes(key)) {
          continue
        }
        
        // Skip undefined values
        if (value === undefined) {
          continue
        }
        
        // Recursively clean nested objects/arrays
        const cleanedValue = deepClean(value, depth + 1)
        if (cleanedValue !== undefined) {
          cleaned[key] = cleanedValue
        }
      }
      
      return cleaned
    }

    const sanitizedOrder = deepClean(orderData)

    // CRITICAL: Final verification - no undefined values
    const checkForUndefined = (obj: any, path = ''): string[] => {
      const undefinedPaths: string[] = []
      if (obj === null || typeof obj !== 'object') return undefinedPaths
      
      if (Array.isArray(obj)) {
        obj.forEach((item, idx) => {
          if (item === undefined) {
            undefinedPaths.push(`${path}[${idx}]`)
          } else {
            undefinedPaths.push(...checkForUndefined(item, `${path}[${idx}]`))
          }
        })
      } else {
        for (const [key, value] of Object.entries(obj)) {
          const currentPath = path ? `${path}.${key}` : key
          if (value === undefined) {
            undefinedPaths.push(currentPath)
          } else if (typeof value === 'object' && value !== null) {
            undefinedPaths.push(...checkForUndefined(value, currentPath))
          }
        }
      }
      return undefinedPaths
    }

    const undefinedPaths = checkForUndefined(sanitizedOrder)
    if (undefinedPaths.length > 0) {
      throw new Error(`Order contains undefined values at: ${undefinedPaths.join(', ')}`)
    }

    // CRITICAL: Final verification - no forbidden fields
    const checkForForbidden = (obj: any, path = ''): string[] => {
      const forbiddenPaths: string[] = []
      const forbiddenFields = ['customer_email', 'customer_name', 'customer_phone']
      
      if (obj === null || typeof obj !== 'object') return forbiddenPaths
      
      if (Array.isArray(obj)) {
        obj.forEach((item, idx) => {
          forbiddenPaths.push(...checkForForbidden(item, `${path}[${idx}]`))
        })
      } else {
        for (const [key, value] of Object.entries(obj)) {
          const currentPath = path ? `${path}.${key}` : key
          if (forbiddenFields.includes(key)) {
            forbiddenPaths.push(currentPath)
          } else if (typeof value === 'object' && value !== null) {
            forbiddenPaths.push(...checkForForbidden(value, currentPath))
          }
        }
      }
      return forbiddenPaths
    }

    const forbiddenPaths = checkForForbidden(sanitizedOrder)
    if (forbiddenPaths.length > 0) {
      throw new Error(`Order contains forbidden customer fields at: ${forbiddenPaths.join(', ')}`)
    }

    if (!db) {
      throw new Error('Firestore not initialized on server')
    }

    // FINAL NUCLEAR OPTION: JSON round-trip to ensure pure POJO
    const finalOrder = JSON.parse(JSON.stringify(sanitizedOrder))

    // DEBUG: Final verification before Firestore write
    console.log('🟢 API ROUTE - Final order keys:', Object.keys(finalOrder))
    console.log('🟢 API ROUTE - Has customer_email?', 'customer_email' in finalOrder)
    console.log('🟢 API ROUTE - Has undefined?', JSON.stringify(finalOrder).includes('undefined'))
    
    // One more explicit removal just before write
    if ('customer_email' in finalOrder) {
      delete finalOrder.customer_email
      console.log('🔴 API ROUTE - DELETED customer_email just before write!')
    }

    const docRef = await addDoc(collection(db, 'orders'), finalOrder)
    console.log('✅ API ROUTE - Order created successfully:', docRef.id)

    return NextResponse.json({ orderId: docRef.id }, { status: 201 })
  } catch (error: any) {
    console.error('ORDER CREATION FAILURE:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to create order' },
      { status: 500 }
    )
  }
}
