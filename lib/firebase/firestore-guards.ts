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
  const forbidden = ['customer_email', 'customerEmail']
  
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
    
    // Check if key itself is forbidden
    if (forbidden.includes(key)) {
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
  // CRITICAL: Check for customer_email before anything else
  const objJson = JSON.stringify(obj)
  if (objJson.includes('customer_email') || objJson.includes('customerEmail')) {
    console.error('🚨 CRITICAL: customer_email found in object JSON!')
    console.error('🚨 Object:', objJson)
    throw new Error('FORBIDDEN FIELD DETECTED: customer_email or customerEmail found in object')
  }
  
  // First, assert no forbidden fields
  assertNoForbiddenFields(obj)
  
  // Then, remove undefined values
  const cleaned = removeUndefinedDeep(obj)
  
  // CRITICAL: Check again after cleaning
  const cleanedJson = JSON.stringify(cleaned)
  if (cleanedJson.includes('customer_email') || cleanedJson.includes('customerEmail')) {
    console.error('🚨 CRITICAL: customer_email found AFTER cleaning!')
    console.error('🚨 Cleaned object:', cleanedJson)
    throw new Error('FORBIDDEN FIELD DETECTED: customer_email or customerEmail found after cleaning')
  }
  
  // Final check: ensure no undefined values remain
  if (cleanedJson.includes('undefined')) {
    throw new Error('CRITICAL: Undefined values still exist after sanitization')
  }
  
  // CRITICAL: Explicitly check the object keys
  if ('customer_email' in cleaned || 'customerEmail' in cleaned) {
    console.error('🚨 CRITICAL: customer_email found in cleaned object keys!')
    console.error('🚨 Keys:', Object.keys(cleaned))
    throw new Error('FORBIDDEN FIELD DETECTED: customer_email or customerEmail in object keys')
  }
  
  return cleaned
}

