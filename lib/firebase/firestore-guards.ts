/**
 * FIRESTORE WRITE GUARDS
 * 
 * These functions ensure no forbidden fields or undefined values
 * ever reach Firestore, preventing "Unsupported field value: undefined" errors.
 */

/**
 * STEP 2: Firestore Write Guard (MANDATORY)
 * 
 * Throws error if any forbidden field is detected.
 * This must be called immediately before addDoc().
 */
export function assertNoForbiddenFields(obj: any, path = ''): void {
  // Only check for customer email fields, not general 'email' (used for auth)
  const forbidden: string[] = ['customer_email', 'customerEmail']
  
  if (obj === null || typeof obj !== 'object') {
    return
  }
  
  if (Array.isArray(obj)) {
    obj.forEach((item, idx) => {
      assertNoForbiddenFields(item, `${path}[${idx}]`)
    })
    return
  }
  
  for (const key of Object.keys(obj)) {
    const currentPath = path ? `${path}.${key}` : key
    
    // Check if key itself is forbidden (defensive guard)
    // CRITICAL: Allow customer_email: null but reject any other value
    if (Array.isArray(forbidden) && forbidden.includes(key)) {
      // Special case: allow customer_email: null (required for Firestore schema)
      if (key === 'customer_email' && obj[key] === null) {
        // Allow it - this is the only acceptable value
        continue
      }
      // Reject customerEmail in any form, or customer_email with non-null value
      throw new Error(`FORBIDDEN FIELD DETECTED: ${key} at path: ${currentPath}`)
    }
    
    // Recursively check nested objects
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      assertNoForbiddenFields(obj[key], currentPath)
    }
  }
}

/**
 * STEP 3: Deep Sanitization
 * 
 * Recursively removes all undefined values from an object.
 * This must be applied right before writing to Firestore.
 */
export function removeUndefinedDeep(obj: any): any {
  if (obj === null) {
    return null
  }
  
  if (Array.isArray(obj)) {
    return obj.map(removeUndefinedDeep).filter(item => item !== undefined)
  }
  
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([_, v]) => v !== undefined)
        .map(([k, v]) => [k, removeUndefinedDeep(v)])
    )
  }
  
  return obj
}

/**
 * Combined guard and sanitization
 * 
 * This is the final step before Firestore write:
 * 1. Asserts no forbidden fields exist
 * 2. Removes all undefined values
 * 3. Returns clean object ready for Firestore
 */
export function prepareForFirestore(obj: any): any {
  // Defensive guard: handle null/undefined input
  if (obj === null || obj === undefined) {
    return null
  }
  
  // CRITICAL: Check for customer_email before anything else
  // Defensive guard: JSON.stringify can throw on circular references, so wrap in try-catch
  let objJson: string
  try {
    objJson = JSON.stringify(obj)
  } catch (err) {
    console.warn('⚠️ JSON.stringify failed, skipping JSON check:', err)
    objJson = ''
  }
  
  // CRITICAL: Check object directly for customer_email with non-null values
  // We allow customer_email: null but reject any other value (string, undefined, etc.)
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    if ('customer_email' in obj && obj.customer_email !== null) {
      console.error('🚨 CRITICAL: customer_email found with non-null value!')
      console.error('🚨 Value:', obj.customer_email)
      throw new Error('FORBIDDEN FIELD DETECTED: customer_email found with non-null value')
    }
    if ('customerEmail' in obj) {
      // Reject customerEmail in any form (should not exist at all)
      console.error('🚨 CRITICAL: customerEmail found!')
      console.error('🚨 Value:', obj.customerEmail)
      throw new Error('FORBIDDEN FIELD DETECTED: customerEmail found in object')
    }
  }
  
  // First, assert no forbidden fields
  try {
    assertNoForbiddenFields(obj)
  } catch (err) {
    // Re-throw assertion errors
    throw err
  }
  
  // Then, remove undefined values
  const cleaned = removeUndefinedDeep(obj)
  
  // CRITICAL: Check again after cleaning
  let cleanedJson: string
  try {
    cleanedJson = JSON.stringify(cleaned)
  } catch (err) {
    console.warn('⚠️ JSON.stringify failed on cleaned object, skipping JSON check:', err)
    cleanedJson = ''
  }
  
  // CRITICAL: Check cleaned object directly for customer_email with non-null values
  if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)) {
    if ('customer_email' in cleaned && cleaned.customer_email !== null) {
      console.error('🚨 CRITICAL: customer_email found AFTER cleaning with non-null value!')
      console.error('🚨 Value:', cleaned.customer_email)
      throw new Error('FORBIDDEN FIELD DETECTED: customer_email found after cleaning with non-null value')
    }
    if ('customerEmail' in cleaned) {
      // Reject customerEmail in any form
      console.error('🚨 CRITICAL: customerEmail found AFTER cleaning!')
      console.error('🚨 Value:', cleaned.customerEmail)
      throw new Error('FORBIDDEN FIELD DETECTED: customerEmail found after cleaning')
    }
  }
  
  // Final check: ensure no undefined values remain in JSON string
  if (typeof cleanedJson === 'string' && cleanedJson.length > 0) {
    // Check for undefined values (shouldn't appear in JSON but be defensive)
    if (cleanedJson.includes(':undefined') || cleanedJson.includes(',undefined')) {
      throw new Error('CRITICAL: Undefined values still exist after sanitization')
    }
  }
  
  // CRITICAL: Explicitly check the object keys
  // Allow customer_email: null but reject any other value
  if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned)) {
    if ('customer_email' in cleaned) {
      // Only allow if the value is explicitly null
      if (cleaned.customer_email !== null) {
        console.error('🚨 CRITICAL: customer_email found in cleaned object with non-null value!')
        console.error('🚨 Keys:', Object.keys(cleaned))
        console.error('🚨 Value:', cleaned.customer_email)
        throw new Error('FORBIDDEN FIELD DETECTED: customer_email in object keys with non-null value')
      }
    }
    if ('customerEmail' in cleaned) {
      // Reject customerEmail in any form (should not exist at all)
      console.error('🚨 CRITICAL: customerEmail found in cleaned object!')
      console.error('🚨 Keys:', Object.keys(cleaned))
      throw new Error('FORBIDDEN FIELD DETECTED: customerEmail in object keys')
    }
  }
  
  return cleaned
}

