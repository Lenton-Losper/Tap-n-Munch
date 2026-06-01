import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://ihlmmpmolnpchzgwyhgh.supabase.co'
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlobG1tcG1vbG5wY2h6Z3d5aGdoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njg3NDcwMCwiZXhwIjoyMDkyNDUwNzAwfQ.lTlLVVazNXYuLz0YNnhERkyZG9m9G7FOAStj5Xm5WnM'

const EMAIL = 'flashtapapp2@gmail.com'
const PASSWORD = '!Shadoey01'
const RESTAURANT_NAME = 'KHP'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

type CategorySeed = { name: string; display_order: number }
type ItemSeed = { category: string; name: string; description: string; base_price: number }

const categories: CategorySeed[] = [
  { name: 'Toasted Sandwiches', display_order: 1 },
  { name: 'Burgers', display_order: 2 },
  { name: 'Salads', display_order: 3 },
  { name: 'Pasta', display_order: 4 },
  { name: 'Mains', display_order: 5 },
  { name: 'Dinner Specials', display_order: 6 },
  { name: 'Chinese Stir Fry', display_order: 7 },
  { name: 'Sides', display_order: 8 },
  { name: 'Seafood Platters', display_order: 9 },
]

const items: ItemSeed[] = [
  { category: 'Toasted Sandwiches', name: 'Ham, Cheese and Tomato', description: 'Served with fries', base_price: 60 },
  { category: 'Toasted Sandwiches', name: 'Chicken Mayo', description: 'Served with fries', base_price: 70 },
  { category: 'Toasted Sandwiches', name: 'Tuna Mayo', description: 'Served with fries', base_price: 65 },
  { category: 'Toasted Sandwiches', name: 'Mixed Polony', description: 'Served with fries', base_price: 60 },
  { category: 'Toasted Sandwiches', name: 'KHP Club', description: 'Ham, fried egg, cheese, bacon, tomato, lettuce. Served with fries', base_price: 95 },
  { category: 'Burgers', name: 'Classic Burger', description: 'Beef patti and garden fresh veggies. Served with fries and onion rings', base_price: 90 },
  { category: 'Burgers', name: 'Chicken Burger', description: 'Chicken patti and garden fresh veggies. Served with fries and onion rings', base_price: 90 },
  { category: 'Burgers', name: 'Sossusvlei Burger', description: 'Beef patti, cheese, fried egg, lettuce and tomato. Served with fries and onion rings', base_price: 110 },
  { category: 'Burgers', name: 'Sesriem Burger', description: 'Beef patti, bacon, egg, cheese, mushrooms, tomato and lettuce. Served with fries and onion rings', base_price: 145 },
  { category: 'Salads', name: 'Greek Salad', description: 'Classic and traditional served with a salad dressing', base_price: 55 },
  { category: 'Salads', name: 'Tuna Salad', description: 'Served with a crostini and dressing', base_price: 70 },
  { category: 'Salads', name: 'KHP Salad', description: 'In-house green salad with toppings (bacon or chicken or beef) with croutons and feta cheese', base_price: 90 },
  { category: 'Pasta', name: 'Chicken Pasta', description: 'Locally farmed chicken with crispy veggies and mushrooms. Choice of spaghetti, tagliatelli or penne', base_price: 85 },
  { category: 'Pasta', name: 'Sossusvlei Pasta', description: 'Grass fed beef with homegrown vegetables with soya and BBQ sauce', base_price: 110 },
  { category: 'Pasta', name: 'KHP Special Pasta', description: 'Mushrooms, peppers, spring onion, carrots, ginger, garlic and smoked bacon', base_price: 90 },
  { category: 'Mains', name: 'Spicy Chicken Wings', description: 'Barbecue flavored grilled chicken wings served with potato fries or green salad', base_price: 115 },
  { category: 'Mains', name: 'Kapana', description: 'Beef strips sauteed and served with pap and salsa', base_price: 100 },
  { category: 'Mains', name: 'Fish and Chips', description: 'Atlantic catch, grilled hake fillet served with fries', base_price: 80 },
  { category: 'Dinner Specials', name: 'Sirloin Steak', description: 'Grass fed and locally farmed, served with pepper sauce, potato wedges and seasonal vegetables', base_price: 250 },
  { category: 'Dinner Specials', name: 'Rump Steak', description: 'Grass fed and locally farmed, served with mushroom sauce, potato wedges and house green salad', base_price: 220 },
  { category: 'Dinner Specials', name: 'Pork/Beef Ribs', description: 'Flame grilled sticky ribs with tangy basting, served with fries and house green salad', base_price: 175 },
  { category: 'Dinner Specials', name: 'Surf and Turf Platter', description: 'Hake or calamari or prawns and beef rump with mashed potatoes, butternut puree and green salad', base_price: 250 },
  { category: 'Dinner Specials', name: 'Deep Catch Platter', description: 'Hake, prawns, mussels, calamari and mixed seafood with fries, volute sauce and green salad', base_price: 350 },
  { category: 'Dinner Specials', name: 'Esplatada', description: 'Selection of beef, lamb, pork and chicken served with potato wedges and pepper sauce', base_price: 250 },
  { category: 'Dinner Specials', name: 'Namibian Meat Platter', description: 'Maize served with grilled lamb, pork, chicken, beef and sausage with mixed vegetable salsa', base_price: 290 },
  { category: 'Dinner Specials', name: 'Oxtail', description: 'Slow cooked with tomatoes, carrots, green beans and garlic. Served with mashed potatoes or rice', base_price: 225 },
  { category: 'Dinner Specials', name: 'Southern Lamb Neck', description: 'Slowly cooked with herb sauce, served with rice or pap', base_price: 210 },
  { category: 'Dinner Specials', name: 'Namibian Lamb Shank', description: 'Braised in rich herb gravy, served with rice or mashed potatoes and green beans', base_price: 190 },
  { category: 'Dinner Specials', name: 'Cape Malay Chicken Curry', description: 'Traditionally made with Malay spices, served with rice and brown lentils', base_price: 175 },
  { category: 'Dinner Specials', name: 'Namibian T-Bone', description: 'Grilled T-bone served with potato wedges, seasonal vegetables and pepper sauce', base_price: 250 },
  { category: 'Chinese Stir Fry', name: 'Chicken Stir Fry', description: 'Choice of tagliatelli, penne, spaghetti or rice. With mushrooms, peppers, cabbage, onions and tomatoes', base_price: 125 },
  { category: 'Chinese Stir Fry', name: 'Beef Stir Fry', description: 'Choice of tagliatelli, penne, spaghetti or rice. With mushrooms, peppers, cabbage, onions and tomatoes', base_price: 130 },
  { category: 'Chinese Stir Fry', name: 'Seafood Stir Fry', description: 'Choice of tagliatelli, penne, spaghetti or rice. With mushrooms, peppers, cabbage, onions and tomatoes', base_price: 150 },
  { category: 'Sides', name: 'Side of the Day', description: 'Creamy spinach, potato wedges, butternut, maize porridge, tomato and onion salsa, or plain fries', base_price: 40 },
  { category: 'Sides', name: 'Extra Sauce', description: 'Cheese, mushroom, black pepper or BBQ sauce', base_price: 45 },
  { category: 'Seafood Platters', name: 'Seafood Boil', description: 'Prawns, calamari, mussels, shrimps, mixed seafood, corn, potatoes and eggs', base_price: 250 },
  { category: 'Seafood Platters', name: 'Baainer Platter', description: 'Prawns (2), calamari (3), seafood mix', base_price: 100 },
  { category: 'Seafood Platters', name: 'Buchter Platter', description: 'Prawns (2), calamari (3), hake, mussels (5), crab (1)', base_price: 150 },
  { category: 'Seafood Platters', name: 'Atlantic Platter', description: 'Prawns (4), hake (1), mussels (5), mixed seafood', base_price: 150 },
  { category: 'Seafood Platters', name: 'Swakopmunder', description: 'Shrimps, mussels (5), calamari (4), prawns (2)', base_price: 120 },
]

async function findAuthUserByEmail(email: string) {
  let page = 1
  const perPage = 100
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage })
    if (error) throw error

    const users = data.users || []
    const found = users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    if (found) return found

    if (users.length < perPage) return null
    page += 1
  }
}

async function cleanupExistingUser() {
  const existing = await findAuthUserByEmail(EMAIL)
  if (!existing) {
    console.log('No existing auth user found for email:', EMAIL)
    return
  }
  const { error } = await supabase.auth.admin.deleteUser(existing.id)
  if (error) throw error
  console.log('Deleted existing auth user:', existing.id)
}

async function cleanupExistingRestaurantByName() {
  const { data: restaurants, error } = await supabase
    .from('restaurants')
    .select('id, name')
    .eq('name', RESTAURANT_NAME)
  if (error) throw error

  if (!restaurants || restaurants.length === 0) {
    console.log('No existing restaurant found named:', RESTAURANT_NAME)
    return
  }

  for (const restaurant of restaurants) {
    const restaurantId = restaurant.id as string
    console.log('Cleaning existing restaurant:', restaurantId)

    const { data: categoryRows, error: categorySelectError } = await supabase
      .from('menu_categories')
      .select('id')
      .eq('restaurant_id', restaurantId)
    if (categorySelectError) throw categorySelectError

    const categoryIds = (categoryRows || []).map((c: any) => c.id).filter(Boolean)

    if (categoryIds.length > 0) {
      const { error: deleteItemsByCategoryError } = await supabase
        .from('menu_items')
        .delete()
        .in('category_id', categoryIds)
      if (deleteItemsByCategoryError) throw deleteItemsByCategoryError
    }

    const { error: deleteItemsByRestaurantError } = await supabase
      .from('menu_items')
      .delete()
      .eq('restaurant_id', restaurantId)
    if (deleteItemsByRestaurantError) throw deleteItemsByRestaurantError

    const { error: deleteCategoriesError } = await supabase
      .from('menu_categories')
      .delete()
      .eq('restaurant_id', restaurantId)
    if (deleteCategoriesError) throw deleteCategoriesError

    const { error: deleteUsersError } = await supabase
      .from('users')
      .delete()
      .eq('restaurant_id', restaurantId)
    if (deleteUsersError) throw deleteUsersError

    const { error: deleteRestaurantError } = await supabase
      .from('restaurants')
      .delete()
      .eq('id', restaurantId)
    if (deleteRestaurantError) throw deleteRestaurantError

    console.log('Deleted existing restaurant and related data:', restaurantId)
  }
}

async function onboard() {
  await cleanupExistingUser()
  await cleanupExistingRestaurantByName()

  const { data: authUserData, error: authError } = await supabase.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
  })
  if (authError) throw authError
  if (!authUserData.user?.id) throw new Error('Auth user created without an id')
  const userId = authUserData.user.id
  console.log('Auth user created:', userId)

  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .insert({ name: RESTAURANT_NAME })
    .select('id,name')
    .single()
  if (restaurantError) throw restaurantError
  if (!restaurant?.id) throw new Error('Restaurant created without an id')
  const restaurantId = restaurant.id as string
  console.log('Restaurant created:', restaurantId)

  const { error: profileError } = await supabase.from('users').insert({
    id: userId,
    email: EMAIL,
    restaurant_id: restaurantId,
    role: 'owner',
  })
  if (profileError) throw profileError
  console.log('User profile created')

  const { data: createdCategories, error: categoryError } = await supabase
    .from('menu_categories')
    .insert(categories.map((c) => ({ ...c, restaurant_id: restaurantId })))
    .select('id,name')
  if (categoryError) throw categoryError
  console.log('Categories created:', createdCategories.length)

  const categoryIdByName = Object.fromEntries(
    (createdCategories || []).map((c: any) => [String(c.name), String(c.id)])
  ) as Record<string, string>

  const menuItemPayload = items.map((item) => {
    const categoryId = categoryIdByName[item.category]
    if (!categoryId) {
      throw new Error(`Missing category id for category: ${item.category}`)
    }
    return {
      restaurant_id: restaurantId,
      category_id: categoryId,
      name: item.name,
      description: item.description,
      base_price: item.base_price,
      status: 'available',
    }
  })

  const { error: menuItemError } = await supabase
    .from('menu_items')
    .insert(menuItemPayload)
  if (menuItemError) throw menuItemError
  console.log('Menu items created:', menuItemPayload.length)

  console.log('✅ KHP onboarded successfully!')
  console.log('Restaurant ID:', restaurantId)
}

onboard().catch((error) => {
  console.error('Onboarding failed:', error)
})
