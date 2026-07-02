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

  if (data.is_popular !== undefined) payload.is_popular = Boolean(data.is_popular)

  const imageFit = data.image_fit ?? data.imageFit
  if (imageFit !== undefined) payload.image_fit = String(imageFit)

  const imagePosition = data.image_position ?? data.imagePosition
  if (imagePosition !== undefined) payload.image_position = String(imagePosition)

  if (data.allow_special_instructions !== undefined) {
    payload.allow_special_instructions = Boolean(data.allow_special_instructions)
  }

  if (data.has_sizes !== undefined) payload.has_sizes = Boolean(data.has_sizes)
  if (data.sizes !== undefined) payload.sizes = data.sizes

  if (data.has_addons !== undefined) payload.has_addons = Boolean(data.has_addons)
  if (data.addons !== undefined) payload.addons = data.addons

  if (data.track_inventory !== undefined) {
    payload.track_inventory = Boolean(data.track_inventory)
  }

  return payload
}
