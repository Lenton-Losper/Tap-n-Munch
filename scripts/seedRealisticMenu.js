/**
 * Seed realistic restaurant + bar menu data for demo environments.
 *
 * Safe-by-default behavior:
 * - Preserves legitimate existing items (especially cocktail/bar style items)
 * - Removes only obvious placeholder/test/demo items
 * - Adds missing realistic data grouped by category/subcategory
 *
 * Usage:
 *   node scripts/seedRealisticMenu.js --email you@example.com --password "your-password"
 *   node scripts/seedRealisticMenu.js --email you@example.com --password "your-password" --restaurantId abc123
 *   node scripts/seedRealisticMenu.js --email you@example.com --password "your-password" --dryRun
 */

try {
  require('dotenv').config({ path: '.env.local' })
} catch (e) {
  // dotenv optional
}

const { initializeApp, getApps } = require('firebase/app')
const {
  getFirestore,
  collection,
  addDoc,
  getDocs,
  query,
  where,
  limit,
  doc,
  getDoc,
  deleteDoc,
  updateDoc,
} = require('firebase/firestore')
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth')

function parseArgs() {
  const args = process.argv.slice(2)
  const out = {
    email: '',
    password: '',
    restaurantId: '',
    dryRun: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--email') out.email = args[++i] || ''
    else if (arg === '--password') out.password = args[++i] || ''
    else if (arg === '--restaurantId') out.restaurantId = args[++i] || ''
    else if (arg === '--dryRun') out.dryRun = true
  }

  return out
}

const {
  email,
  password,
  restaurantId: restaurantIdArg,
  dryRun,
} = parseArgs()

if (!email || !password) {
  console.error(
    'Usage: node scripts/seedRealisticMenu.js --email you@example.com --password "your-password" [--restaurantId id] [--dryRun]'
  )
  process.exit(1)
}

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  console.error('Missing Firebase env vars. Ensure NEXT_PUBLIC_FIREBASE_* is configured.')
  process.exit(1)
}

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig)
const db = getFirestore(app)
const auth = getAuth(app)

const realisticMenuBlueprint = [
  {
    category: 'Food',
    subCategory: 'Small Plates',
    items: [
      {
        name: 'Smoked Beef Carpaccio',
        description: 'Thinly sliced beef, capers, parmesan shavings, rocket, lemon olive oil.',
        base_price: 98,
        image_url:
          'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=1200&q=80',
      },
      {
        name: 'Crispy Calamari',
        description: 'Lightly dusted squid rings, lemon aioli, charred lemon.',
        base_price: 92,
        image_url:
          'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?auto=format&fit=crop&w=1200&q=80',
      },
      {
        name: 'Garlic Prawn Skillet',
        description: 'Pan-seared prawns in garlic butter, chili flakes, toasted sourdough.',
        base_price: 118,
        image_url:
          'https://images.unsplash.com/photo-1565299507177-b0ac66763828?auto=format&fit=crop&w=1200&q=80',
      },
    ],
  },
  {
    category: 'Food',
    subCategory: 'Grill & Signature',
    items: [
      {
        name: 'Flame-Grilled Sirloin (300g)',
        description: 'Aged beef sirloin, herb butter, chips or seasonal vegetables.',
        base_price: 245,
        image_url:
          'https://images.unsplash.com/photo-1558030006-450675393462?auto=format&fit=crop&w=1200&q=80',
      },
      {
        name: 'Herb Roast Chicken Supreme',
        description: 'Roasted chicken breast, creamy mash, pan jus, roasted carrots.',
        base_price: 178,
        image_url:
          'https://images.unsplash.com/photo-1598103442097-8b74394b95c6?auto=format&fit=crop&w=1200&q=80',
      },
      {
        name: 'Pan-Seared Atlantic Salmon',
        description: 'Lemon-dill butter sauce, sautéed greens, roasted baby potatoes.',
        base_price: 228,
        image_url:
          'https://images.unsplash.com/photo-1467003909585-2f8a72700288?auto=format&fit=crop&w=1200&q=80',
      },
      {
        name: 'Mushroom Truffle Linguine',
        description: 'Fresh linguine, wild mushrooms, parmesan, truffle cream.',
        base_price: 165,
        image_url:
          'https://images.unsplash.com/photo-1621996346565-e3dbc353d2e5?auto=format&fit=crop&w=1200&q=80',
      },
    ],
  },
  {
    category: 'Food',
    subCategory: 'Sweet Finish',
    items: [
      {
        name: 'Chocolate Lava Cake',
        description: 'Warm chocolate center, vanilla bean ice cream, cocoa dust.',
        base_price: 84,
        image_url:
          'https://images.unsplash.com/photo-1564355808539-22fda35bed7e?auto=format&fit=crop&w=1200&q=80',
      },
      {
        name: 'Classic Creme Brulee',
        description: 'Silky vanilla custard with caramelized sugar crust.',
        base_price: 78,
        image_url:
          'https://images.unsplash.com/photo-1470124182917-cc6e71b22ecc?auto=format&fit=crop&w=1200&q=80',
      },
    ],
  },
  {
    category: 'Drinks',
    subCategory: 'Cocktails',
    items: [
      {
        name: 'Namib Sunset',
        description: 'Gin, orange bitters, citrus cordial, tonic, rosemary smoke.',
        base_price: 92,
        image_url:
          'https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?auto=format&fit=crop&w=1200&q=80',
      },
      {
        name: 'Windhoek Mule',
        description: 'Vodka, ginger beer, lime, mint, served over crushed ice.',
        base_price: 86,
        image_url:
          'https://images.unsplash.com/photo-1544145945-f904253d0c7b?auto=format&fit=crop&w=1200&q=80',
      },
    ],
  },
  {
    category: 'Drinks',
    subCategory: 'Non-Alcoholic',
    items: [
      {
        name: 'Fresh Brewed Iced Tea',
        description: 'House-brewed black tea, lemon, optional peach syrup.',
        base_price: 38,
        image_url:
          'https://images.unsplash.com/photo-1499638673689-79a0b5115d87?auto=format&fit=crop&w=1200&q=80',
      },
      {
        name: 'Passionfruit Sparkler',
        description: 'Passionfruit puree, soda, lime, mint.',
        base_price: 42,
        image_url:
          'https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=1200&q=80',
      },
    ],
  },
]

function normalized(value) {
  return (value || '').trim().toLowerCase()
}

function isLikelyPlaceholder(item) {
  const name = normalized(item.name)
  const description = normalized(item.description)
  const placeholderPattern =
    /(test|sample|placeholder|demo|lorem|ipsum|untitled|example|item\s*\d+|new item|food item|drink item)/

  if (!name) return true
  if (placeholderPattern.test(name)) return true
  if (description && placeholderPattern.test(description)) return true
  return false
}

function isLikelyLegitBarItem(item) {
  const text = `${normalized(item.name)} ${normalized(item.description)}`
  return /(cocktail|martini|mule|mojito|spirits|beer|wine|whisky|vodka|gin|rum|tequila|mocktail|sling|negroni|volcano|fizz)/.test(
    text
  )
}

const beerImageByName = {
  'blue moon':
    'https://source.unsplash.com/1200x900/?blue-moon-beer&sig=1',
  'bud light':
    'https://source.unsplash.com/1200x900/?bud-light-beer&sig=2',
  budweiser:
    'https://source.unsplash.com/1200x900/?budweiser-beer&sig=3',
  corona:
    'https://source.unsplash.com/1200x900/?corona-beer&sig=4',
  'free verse':
    'https://source.unsplash.com/1200x900/?craft-beer-pint&sig=5',
  'kirin ichiban':
    'https://source.unsplash.com/1200x900/?lager-beer-bottle&sig=6',
  'miller lite':
    'https://source.unsplash.com/1200x900/?beer-can-cold&sig=7',
  'sam adams':
    'https://source.unsplash.com/1200x900/?sam-adams-beer&sig=8',
  stella:
    'https://source.unsplash.com/1200x900/?stella-artois-beer&sig=9',
  'tsing tao':
    'https://source.unsplash.com/1200x900/?tsingtao-beer&sig=10',
  heineken:
    'https://source.unsplash.com/1200x900/?heineken-beer&sig=11',
}

const fallbackBeerImages = [
  'https://source.unsplash.com/1200x900/?beer&sig=21',
  'https://source.unsplash.com/1200x900/?lager&sig=22',
  'https://source.unsplash.com/1200x900/?pilsner&sig=23',
  'https://source.unsplash.com/1200x900/?ale-beer&sig=24',
  'https://source.unsplash.com/1200x900/?craft-brewery-beer&sig=25',
  'https://source.unsplash.com/1200x900/?beer-glass&sig=26',
  'https://source.unsplash.com/1200x900/?cold-beer&sig=27',
]

function resolveBeerImage(itemName, fallbackIndex) {
  const name = normalized(itemName)
  for (const [key, url] of Object.entries(beerImageByName)) {
    if (name.includes(key)) return url
  }
  return fallbackBeerImages[fallbackIndex % fallbackBeerImages.length]
}

async function authenticateUser() {
  const credential = await signInWithEmailAndPassword(auth, email, password)
  return credential.user
}

async function resolveRestaurantId(user) {
  if (restaurantIdArg) return restaurantIdArg

  // Try user profile document first.
  const userDoc = await getDoc(doc(db, 'users', user.uid))
  if (userDoc.exists() && userDoc.data()?.restaurant_id) {
    return userDoc.data().restaurant_id
  }

  // Fallback: restaurant by email.
  const restaurantsRef = collection(db, 'restaurants')
  const emailQuery = query(restaurantsRef, where('email', '==', user.email), limit(1))
  const emailSnap = await getDocs(emailQuery)
  if (!emailSnap.empty) return emailSnap.docs[0].id

  throw new Error('Could not determine restaurantId. Pass --restaurantId explicitly.')
}

async function getOrCreateMenuCategory(restaurantId, categoryName) {
  const categoriesRef = collection(db, `restaurants/${restaurantId}/menu/data/categories`)
  const activeQuery = query(categoriesRef, where('active', '==', true))
  const snapshot = await getDocs(activeQuery)

  const existing = snapshot.docs.find((d) => normalized(d.data().name) === normalized(categoryName))
  if (existing) return existing.id

  const maxOrder = snapshot.empty
    ? 0
    : Math.max(...snapshot.docs.map((d) => d.data().display_order || 0))

  if (dryRun) return `dry-category-${normalized(categoryName).replace(/\s+/g, '-')}`

  const newCategory = await addDoc(categoriesRef, {
    name: categoryName,
    description: null,
    display_order: maxOrder + 1,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  return newCategory.id
}

async function getOrCreateSubCategory(restaurantId, categoryId, subCategoryName) {
  const subRef = collection(
    db,
    `restaurants/${restaurantId}/menu/data/categories/${categoryId}/subcategories`
  )
  const activeQuery = query(subRef, where('active', '==', true))
  const snapshot = await getDocs(activeQuery)

  const existing = snapshot.docs.find((d) => normalized(d.data().name) === normalized(subCategoryName))
  if (existing) return existing.id

  const maxOrder = snapshot.empty
    ? 0
    : Math.max(...snapshot.docs.map((d) => d.data().display_order || 0))

  if (dryRun) return `dry-sub-${normalized(subCategoryName).replace(/\s+/g, '-')}`

  const newSub = await addDoc(subRef, {
    name: subCategoryName,
    description: null,
    display_order: maxOrder + 1,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  return newSub.id
}

async function fetchAllExistingItems(restaurantId) {
  const categoriesRef = collection(db, `restaurants/${restaurantId}/menu/data/categories`)
  const categoriesSnap = await getDocs(query(categoriesRef, where('active', '==', true)))

  const records = []

  for (const categoryDoc of categoriesSnap.docs) {
    const categoryId = categoryDoc.id
    const categoryName = categoryDoc.data().name || ''
    const subRef = collection(
      db,
      `restaurants/${restaurantId}/menu/data/categories/${categoryId}/subcategories`
    )
    const subSnap = await getDocs(query(subRef, where('active', '==', true)))

    for (const subDoc of subSnap.docs) {
      const subCategoryId = subDoc.id
      const subCategoryName = subDoc.data().name || ''
      const itemsRef = collection(
        db,
        `restaurants/${restaurantId}/menu/data/categories/${categoryId}/subcategories/${subCategoryId}/items`
      )
      const itemSnap = await getDocs(itemsRef)
      for (const itemDoc of itemSnap.docs) {
        records.push({
          id: itemDoc.id,
          refPath: itemDoc.ref.path,
          categoryId,
          categoryName,
          subCategoryId,
          subCategoryName,
          ...itemDoc.data(),
        })
      }
    }
  }

  return records
}

async function removePlaceholderItems(existingItems) {
  let removed = 0
  let keptLegit = 0
  let keptOther = 0

  for (const item of existingItems) {
    const placeholder = isLikelyPlaceholder(item)
    const legitBar = isLikelyLegitBarItem(item)

    // Preserve known-legit bar/cocktail menu entries.
    if (legitBar) {
      keptLegit++
      continue
    }

    if (!placeholder) {
      keptOther++
      continue
    }

    if (dryRun) {
      removed++
      continue
    }

    await deleteDoc(doc(db, item.refPath))
    removed++
  }

  return { removed, keptLegit, keptOther }
}

async function softHideEmptySubCategories(restaurantId, categoryNames) {
  let hiddenCount = 0

  const categoriesRef = collection(db, `restaurants/${restaurantId}/menu/data/categories`)
  const categoriesSnap = await getDocs(query(categoriesRef, where('active', '==', true)))

  const targetCategories = categoriesSnap.docs.filter((categoryDoc) =>
    categoryNames.includes(categoryDoc.data()?.name)
  )

  for (const categoryDoc of targetCategories) {
    const subRef = collection(
      db,
      `restaurants/${restaurantId}/menu/data/categories/${categoryDoc.id}/subcategories`
    )
    const subSnap = await getDocs(query(subRef, where('active', '==', true)))

    for (const subDoc of subSnap.docs) {
      const itemsRef = collection(
        db,
        `restaurants/${restaurantId}/menu/data/categories/${categoryDoc.id}/subcategories/${subDoc.id}/items`
      )
      const itemsSnap = await getDocs(itemsRef)

      if (itemsSnap.size > 0) continue

      if (!dryRun) {
        await updateDoc(doc(db, subDoc.ref.path), {
          active: false,
          updated_at: new Date().toISOString(),
        })
      }
      hiddenCount++
    }
  }

  return hiddenCount
}

function isLikelyFoodOrVenueImage(url) {
  const value = normalized(url || '')
  return /(cake|salad|pasta|steak|burger|dessert|kitchen|restaurant-interior|dining|food)/.test(value)
}

async function normalizeBeerImages(existingItems) {
  const beerItems = existingItems.filter((item) => {
    const categoryText = `${normalized(item.categoryName)} ${normalized(item.subCategoryName)}`
    const itemText = `${normalized(item.name)} ${normalized(item.description)}`
    return /(beer|beers|lager|ale|stout|pilsner|brew)/.test(categoryText) || /(beer|lager|ale|stout|pilsner|brew)/.test(itemText)
  })

  let updated = 0
  for (let i = 0; i < beerItems.length; i++) {
    const item = beerItems[i]
    const targetImage = resolveBeerImage(item.name, i)
    if (item.image_url === targetImage) continue

    if (!dryRun) {
      await updateDoc(doc(db, item.refPath), {
        image_url: targetImage,
        updated_at: new Date().toISOString(),
      })
    }
    updated++
  }

  return updated
}

async function seedMenu(restaurantId) {
  const now = new Date().toISOString()
  const existingItems = await fetchAllExistingItems(restaurantId)
  const existingNameSet = new Set(existingItems.map((i) => normalized(i.name)))

  const cleanupStats = await removePlaceholderItems(existingItems)
  const updatedBeerImages = await normalizeBeerImages(existingItems)

  let added = 0
  let skippedExisting = 0

  for (const group of realisticMenuBlueprint) {
    const categoryId = await getOrCreateMenuCategory(restaurantId, group.category)
    const subCategoryId = await getOrCreateSubCategory(restaurantId, categoryId, group.subCategory)

    for (const item of group.items) {
      const key = normalized(item.name)
      if (existingNameSet.has(key)) {
        skippedExisting++
        continue
      }

      if (!dryRun) {
        const itemsRef = collection(
          db,
          `restaurants/${restaurantId}/menu/data/categories/${categoryId}/subcategories/${subCategoryId}/items`
        )
        await addDoc(itemsRef, {
          name: item.name,
          description: item.description,
          image_url: item.image_url || null,
          base_price: item.base_price,
          menu_category_id: categoryId,
          sub_category_id: subCategoryId,
          has_sizes: false,
          sizes: [],
          has_addons: false,
          addons: [],
          allow_special_instructions: true,
          status: 'available',
          times_ordered: 0,
          total_revenue: 0,
          created_at: now,
          updated_at: now,
        })
      }

      existingNameSet.add(key)
      added++
    }
  }

  const hiddenEmptySubCategories = await softHideEmptySubCategories(restaurantId, ['Food', 'Drinks'])

  return {
    added,
    skippedExisting,
    hiddenEmptySubCategories,
    updatedBeerImages,
    ...cleanupStats,
  }
}

async function main() {
  console.log('🍽️  Realistic menu seed script started...')
  if (dryRun) {
    console.log('ℹ️  Running in DRY RUN mode (no writes/deletes).')
  }

  const user = await authenticateUser()
  const restaurantId = await resolveRestaurantId(user)
  console.log(`✅ Authenticated as ${user.email}`)
  console.log(`🏪 Target restaurant ID: ${restaurantId}`)

  const result = await seedMenu(restaurantId)

  console.log('\n✨ Done.')
  console.log(`🧹 Placeholder/test items removed: ${result.removed}`)
  console.log(`🍸 Legit bar/cocktail items preserved: ${result.keptLegit}`)
  console.log(`📌 Other existing items preserved: ${result.keptOther}`)
  console.log(`➕ New realistic items added: ${result.added}`)
  console.log(`↩️ Existing legitimate items skipped: ${result.skippedExisting}`)
  console.log(`🧼 Empty Food/Drinks sub-categories hidden: ${result.hiddenEmptySubCategories}`)
  console.log(`🍺 Beer item images updated: ${result.updatedBeerImages}`)
}

main().catch((err) => {
  console.error('\n💥 Seed script failed:', err.message)
  process.exit(1)
})

