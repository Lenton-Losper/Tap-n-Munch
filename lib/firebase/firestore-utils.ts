/**
 * Sanitizes data for Firestore by removing undefined values.
 * Firestore does NOT accept undefined - we must use null or omit fields.
 * 
 * @param data - The data object to sanitize
 * @returns A new object with all undefined values removed
 */
export function sanitizeFirestoreData<T extends Record<string, any>>(data: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(data).filter(([_, value]) => value !== undefined)
  ) as Partial<T>
}

/**
 * Converts undefined values to null for Firestore compatibility.
 * Use this when you want to explicitly store null instead of omitting fields.
 * 
 * @param data - The data object to convert
 * @returns A new object with undefined values converted to null
 */
export function convertUndefinedToNull<T extends Record<string, any>>(data: T): Record<string, any> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, value === undefined ? null : value])
  )
}

