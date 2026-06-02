/** Map UI / Firestore-shaped fields to Supabase menu_items columns only. */
export function buildMenuItemDbPayload(data: Record<string, any>): Record<string, any> {
  const payload: Record<string, any> = {}

  if (data.name !== undefined) payload.name = String(data.name).trim()
  if (data.description !== undefined) {
    payload.description = data.description ? String(data.description) : null
  }
  if (data.base_price !== undefined) payload.base_price = Number(data.base_price)
  if (data.image_url !== undefined) {
    payload.image_url = data.image_url ? String(data.image_url) : null
  }
  if (data.category_id !== undefined) payload.category_id = data.category_id || null
  if (data.subcategory_id !== undefined) payload.subcategory_id = data.subcategory_id || null
  if (data.sub_category_id !== undefined) {
    payload.subcategory_id = data.sub_category_id || null
  }

  if (data.status !== undefined) {
    payload.status = String(data.status)
  }

  if (data.variants !== undefined) payload.variants = data.variants
  if (data.variant_groups !== undefined) payload.variant_groups = data.variant_groups
  if (data.variantGroups !== undefined) payload.variant_groups = data.variantGroups

  return payload
}
