export const FOOD_IMAGE_DEFAULT_FALLBACK =
  'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400&h=300&fit=crop'

const foodKeywords: Record<string, string> = {
  burger: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=400&h=300&fit=crop',
  sandwich: 'https://images.unsplash.com/photo-1528735602780-2552fd46c7af?w=400&h=300&fit=crop',
  salad: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400&h=300&fit=crop',
  pasta: 'https://images.unsplash.com/photo-1621996346565-e3dbc646d9a9?w=400&h=300&fit=crop',
  steak: 'https://images.unsplash.com/photo-1546964124-0cce460f38ef?w=400&h=300&fit=crop',
  chicken: 'https://images.unsplash.com/photo-1598103442097-8b74394b95c8?w=400&h=300&fit=crop',
  fish: 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=400&h=300&fit=crop',
  seafood: 'https://images.unsplash.com/photo-1559737558-2f5a35f4523b?w=400&h=300&fit=crop',
  ribs: 'https://images.unsplash.com/photo-1544025162-d76538b2a681?w=400&h=300&fit=crop',
  wings: 'https://images.unsplash.com/photo-1527477396000-e27163b481c2?w=400&h=300&fit=crop',
  curry: 'https://images.unsplash.com/photo-1565557623262-b51c2513a641?w=400&h=300&fit=crop',
  stir: 'https://images.unsplash.com/photo-1512058564366-18510be2db19?w=400&h=300&fit=crop',
  oxtail: 'https://images.unsplash.com/photo-1544025162-d76538b2a681?w=400&h=300&fit=crop',
  prawns: 'https://images.unsplash.com/photo-1559737558-2f5a35f4523b?w=400&h=300&fit=crop',
  lamb: 'https://images.unsplash.com/photo-1546964124-0cce460f38ef?w=400&h=300&fit=crop',
}

export function getFoodImageKeywordFallback(itemName: string): string {
  const lowerName = itemName.toLowerCase()
  for (const [keyword, url] of Object.entries(foodKeywords)) {
    if (lowerName.includes(keyword)) return url
  }
  return FOOD_IMAGE_DEFAULT_FALLBACK
}

export async function getFoodImage(itemName: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(itemName)}`
    )
    const data = await res.json()
    if (data.meals && data.meals[0]?.strMealThumb) {
      return data.meals[0].strMealThumb as string
    }
  } catch {
    // ignore
  }
  return getFoodImageKeywordFallback(itemName)
}
