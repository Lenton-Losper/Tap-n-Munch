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
    // This is the NUCLEAR option - removes customer_email from EVERYWHERE
    function deepClean(obj: any, depth = 0): any {
      if (depth > 10) return obj // Prevent infinite recursion
      if (obj === null || obj === undefined) return null
      if (typeof obj !== 'object') return obj
      
      if (Array.isArray(obj)) {
        return obj.map(item => deepClean(item, depth + 1)).filter(item => item !== undefined && item !== null)
      }
      
      const cleaned: Record<string, any> = {}
      const forbiddenFields = ['customer_email', 'customer_name', 'customer_phone', 'customerEmail', 'customerName', 'customerPhone']
      
      for (const [key, value] of Object.entries(obj)) {
        // ABSOLUTELY SKIP forbidden fields - no exceptions
        if (forbiddenFields.includes(key)) {
          console.log(`🚫 REMOVING forbidden field: ${key}`)
          continue
        }
        
        // ABSOLUTELY SKIP undefined values - no exceptions
        if (value === undefined) {
          console.log(`🚫 REMOVING undefined value for key: ${key}`)
          continue
        }
        
        // Recursively clean nested objects/arrays
        const cleanedValue = deepClean(value, depth + 1)
        if (cleanedValue !== undefined && cleanedValue !== null) {
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
    // This physically removes any undefined values and creates a clean object
    let finalOrder: any
    try {
      finalOrder = JSON.parse(JSON.stringify(sanitizedOrder, (key, value) => {
        // Remove undefined values during stringify
        if (value === undefined) {
          return undefined // JSON.stringify will omit this
        }
        // Remove forbidden fields during stringify
        const forbiddenFields = ['customer_email', 'customer_name', 'customer_phone', 'customerEmail', 'customerName', 'customerPhone']
        if (forbiddenFields.includes(key)) {
          return undefined // JSON.stringify will omit this
        }
        return value
      }))
    } catch (e) {
      throw new Error(`Failed to sanitize order data: ${e}`)
    }

    // ABSOLUTE FINAL CHECK: Remove forbidden fields one more time
    const allForbiddenFields = ['customer_email', 'customer_name', 'customer_phone', 'customerEmail', 'customerName', 'customerPhone']
    allForbiddenFields.forEach(field => {
      if (field in finalOrder) {
        delete finalOrder[field]
        console.log(`🔴 FINAL REMOVAL - Deleted ${field} just before Firestore write`)
      }
    })

    // ABSOLUTE FINAL CHECK: Remove any remaining undefined values
    const finalClean = Object.fromEntries(
      Object.entries(finalOrder).filter(([_, v]) => v !== undefined)
    )

    // DEBUG: Final verification before Firestore write
    console.log('🟢 API ROUTE - Final order keys:', Object.keys(finalClean))
    console.log('🟢 API ROUTE - Has customer_email?', 'customer_email' in finalClean)
    console.log('🟢 API ROUTE - Has undefined?', Object.values(finalClean).some(v => v === undefined))
    
    // THROW ERROR if customer_email still exists (should be impossible)
    if ('customer_email' in finalClean) {
      throw new Error('CRITICAL: customer_email still exists after all cleaning steps!')
    }

    // THROW ERROR if any undefined values exist (should be impossible)
    if (Object.values(finalClean).some(v => v === undefined)) {
      const undefinedKeys = Object.entries(finalClean)
        .filter(([_, v]) => v === undefined)
        .map(([k]) => k)
      throw new Error(`CRITICAL: Undefined values still exist: ${undefinedKeys.join(', ')}`)
    }

    const docRef = await addDoc(collection(db, 'orders'), finalClean)
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
