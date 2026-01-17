/**
 * Bulk Upload Drink Menu Script for Balcony Mix
 * 
 * This script uploads drink menu items to Firestore for Balcony Mix restaurant.
 * 
 * Usage: node scripts/seedBalconyDrinks.js xshadoey@gmail.com yourpassword
 */

try {
  require('dotenv').config({ path: '.env.local' })
} catch (e) {
  // dotenv not installed
}

const { initializeApp, getApps } = require('firebase/app')
const { getFirestore, collection, addDoc, query, where, getDocs, limit, doc, getDoc } = require('firebase/firestore')
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth')
const readline = require('readline')

// Initialize Firebase
let db, auth
try {
  const firebaseConfig = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  }
  
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    throw new Error('Firebase configuration is missing.')
  }
  
  const apps = getApps()
  const app = apps.length === 0 ? initializeApp(firebaseConfig) : apps[0]
  db = getFirestore(app)
  auth = getAuth(app)
  
  console.log('✅ Firebase initialized successfully')
} catch (error) {
  console.error('❌ Failed to initialize Firebase:', error.message)
  process.exit(1)
}

function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })
  
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

async function authenticate() {
  console.log('\n🔐 Authentication Required\n')
  
  const email = process.argv[2] || await promptUser('Enter your email: ')
  const password = process.argv[3] || await promptUser('Enter your password: ')
  
  if (!email || !password) {
    throw new Error('Email and password are required')
  }
  
  try {
    console.log('\n🔑 Signing in...')
    const userCredential = await signInWithEmailAndPassword(auth, email, password)
    console.log(`✅ Signed in as: ${userCredential.user.email}\n`)
    return userCredential.user
  } catch (error) {
    console.error('❌ Authentication failed:', error.message)
    throw error
  }
}

async function findRestaurantByEmailOrName(email, name) {
  console.log(`🔍 Searching for restaurant: "${name}" (owner: ${email})...`)
  
  // First, try to find by email
  const restaurantsRef = collection(db, 'restaurants')
  const emailQuery = query(restaurantsRef, where('email', '==', email), limit(1))
  const emailSnapshot = await getDocs(emailQuery)
  
  if (!emailSnapshot.empty) {
    const restaurant = { id: emailSnapshot.docs[0].id, ...emailSnapshot.docs[0].data() }
    console.log(`✅ Found restaurant by email: "${restaurant.name}" (ID: ${restaurant.id})`)
    return restaurant
  }
  
  // If not found by email, try by name
  const nameQuery = query(restaurantsRef, where('name', '==', name), limit(1))
  const nameSnapshot = await getDocs(nameQuery)
  
  if (!nameSnapshot.empty) {
    const restaurant = { id: nameSnapshot.docs[0].id, ...nameSnapshot.docs[0].data() }
    console.log(`✅ Found restaurant by name: "${restaurant.name}" (ID: ${restaurant.id})`)
    return restaurant
  }
  
  throw new Error(`Restaurant "${name}" not found. Please ensure the restaurant exists in Firestore.`)
}

// Drink Menu Data
const drinkMenuData = [
  // Signature Spirits
  { 
    name: "Flaming Volcano", 
    price: 18, 
    category: "Signature Spirits", 
    imageUrl: "https://images.unsplash.com/photo-1551024709-8f23befc6f87?q=80&w=500"
  },
  { 
    name: "Neo-Buddha", 
    price: 10, 
    category: "Signature Spirits", 
    imageUrl: "https://images.unsplash.com/photo-1556679343-c7306c1976bc?q=80&w=500"
  },
  { 
    name: "Terra Cotta Zombie", 
    price: 10, 
    category: "Signature Spirits", 
    imageUrl: "https://images.unsplash.com/photo-1536935338788-846bb9981813?q=80&w=500"
  },
  { 
    name: "Saketini", 
    price: 9, 
    category: "Signature Spirits", 
    imageUrl: "https://images.unsplash.com/photo-1582731252125-21c67f81c95a?q=80&w=500"
  },
  { 
    name: "Peking Mai Tai", 
    price: 9, 
    category: "Signature Spirits", 
    imageUrl: "https://images.unsplash.com/photo-1513558161293-cdaf765ed2fd?q=80&w=500"
  },
  { 
    name: "Royal Jade", 
    price: 9, 
    category: "Signature Spirits", 
    imageUrl: "https://images.unsplash.com/photo-1559131397-f94da358f7ca?q=80&w=500"
  },
  { 
    name: "Tsingtao Fizz", 
    price: 8, 
    category: "Signature Spirits", 
    imageUrl: "https://images.unsplash.com/photo-1544145945-f904253d0c7b?q=80&w=500"
  },
  { 
    name: "Singapore Sling", 
    price: 10, 
    category: "Signature Spirits", 
    imageUrl: "https://images.unsplash.com/photo-1556855810-ac404aa91f04?q=80&w=500"
  },
  { 
    name: "Han Purple", 
    price: 10, 
    category: "Signature Spirits", 
    imageUrl: "https://images.unsplash.com/photo-1551024709-8f23befc6f87?q=80&w=500"
  },
  { 
    name: "Indonesian Fire Dancer", 
    price: 13, 
    category: "Signature Spirits", 
    imageUrl: "https://images.unsplash.com/photo-1556679343-c7306c1976bc?q=80&w=500"
  },
  
  // Beers
  { 
    name: "Free Verse", 
    price: 5, 
    category: "Beers", 
    imageUrl: "https://images.unsplash.com/photo-1618885472179-5e474019f2a9?q=80&w=500"
  },
  { 
    name: "Saving Daylight", 
    price: 5, 
    category: "Beers", 
    imageUrl: "https://images.unsplash.com/photo-1618885472179-5e474019f2a9?q=80&w=500"
  },
  { 
    name: "Tsing Tao", 
    price: 4, 
    category: "Beers", 
    imageUrl: "https://images.unsplash.com/photo-1618885472179-5e474019f2a9?q=80&w=500"
  },
  { 
    name: "Sapporo (22oz)", 
    price: 6, 
    category: "Beers", 
    imageUrl: "https://images.unsplash.com/photo-1612528443702-f6741f70a049?q=80&w=500"
  },
  { 
    name: "Kirin Ichiban", 
    price: 4, 
    category: "Beers", 
    imageUrl: "https://images.unsplash.com/photo-1618885472179-5e474019f2a9?q=80&w=500"
  },
  { 
    name: "Stella Artois", 
    price: 4, 
    category: "Beers", 
    imageUrl: "https://images.unsplash.com/photo-1597348344664-51c11ee95adb?q=80&w=500"
  },
  { 
    name: "Corona", 
    price: 4, 
    category: "Beers", 
    imageUrl: "https://images.unsplash.com/photo-1551538597-27cb3f1e62bf?q=80&w=500"
  },
  { 
    name: "Blue Moon", 
    price: 4, 
    category: "Beers", 
    imageUrl: "https://images.unsplash.com/photo-1618885472179-5e474019f2a9?q=80&w=500"
  },
  { 
    name: "Sam Adams", 
    price: 4, 
    category: "Beers", 
    imageUrl: "https://images.unsplash.com/photo-1618885472179-5e474019f2a9?q=80&w=500"
  },
  { 
    name: "Budweiser", 
    price: 3, 
    category: "Beers", 
    imageUrl: "https://images.unsplash.com/photo-1618885472179-5e474019f2a9?q=80&w=500"
  },
  { 
    name: "Bud Light", 
    price: 3, 
    category: "Beers", 
    imageUrl: "https://images.unsplash.com/photo-1618885472179-5e474019f2a9?q=80&w=500"
  },
  { 
    name: "Miller Lite", 
    price: 3, 
    category: "Beers", 
    imageUrl: "https://images.unsplash.com/photo-1618885472179-5e474019f2a9?q=80&w=500"
  },
  
  // Non-Alcoholic
  { 
    name: "Pepsi Products", 
    price: 2.99, 
    category: "Non-Alcoholic", 
    imageUrl: "https://images.unsplash.com/photo-1622708741828-384356514d8c?q=80&w=500"
  },
  { 
    name: "Hot Tea", 
    price: 1.5, 
    category: "Non-Alcoholic", 
    imageUrl: "https://images.unsplash.com/photo-1556679343-c7306c1976bc?q=80&w=500"
  },
  { 
    name: "Fresh Brewed Iced Tea", 
    price: 2.99, 
    category: "Non-Alcoholic", 
    imageUrl: "https://images.unsplash.com/photo-1556679343-c7306c1976bc?q=80&w=500"
  },
  { 
    name: "Matcha Green Tea", 
    price: 3, 
    category: "Non-Alcoholic", 
    imageUrl: "https://images.unsplash.com/photo-1582718194302-444a75844060?q=80&w=500"
  },
  { 
    name: "Milk", 
    price: 3, 
    category: "Non-Alcoholic", 
    imageUrl: "https://images.unsplash.com/photo-1550583724-b2692b85b150?q=80&w=500"
  },
  { 
    name: "Shirley Temple", 
    price: 3, 
    category: "Non-Alcoholic", 
    imageUrl: "https://images.unsplash.com/photo-1622708741828-384356514d8c?q=80&w=500"
  },
  { 
    name: "Juices (Apple/Orange/Pineapple/Cranberry)", 
    price: 3, 
    category: "Non-Alcoholic", 
    imageUrl: "https://images.unsplash.com/photo-1600271886742-f049cd451bba?q=80&w=500"
  },
  
  // Boba Tapioca Tea
  { 
    name: "Iced/Milk Tea (Papaya, Taro, Banana, Honeydew, Strawberry, Matcha)", 
    price: 5, 
    category: "Boba Tapioca Tea", 
    imageUrl: "https://images.unsplash.com/photo-1558857563-b371f30ca6a5?q=80&w=500"
  }
]

async function getOrCreateMenuCategory(restaurantId, categoryName) {
  const categoriesRef = collection(db, `restaurants/${restaurantId}/menu/data/categories`)
  
  const q = query(
    categoriesRef,
    where('name', '==', categoryName),
    where('active', '==', true),
    limit(1)
  )
  const snapshot = await getDocs(q)
  
  if (!snapshot.empty) {
    const category = snapshot.docs[0]
    console.log(`✅ Found existing category: "${categoryName}" (ID: ${category.id})`)
    return category.id
  }
  
  const allCategoriesQuery = query(
    categoriesRef,
    where('active', '==', true)
  )
  const allCategoriesSnapshot = await getDocs(allCategoriesQuery)
  const maxOrder = allCategoriesSnapshot.empty 
    ? 0 
    : Math.max(...allCategoriesSnapshot.docs.map(doc => doc.data().display_order || 0))
  
  const newCategoryRef = await addDoc(categoriesRef, {
    name: categoryName,
    description: null,
    display_order: maxOrder + 1,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  
  console.log(`✅ Created new category: "${categoryName}" (ID: ${newCategoryRef.id})`)
  return newCategoryRef.id
}

async function getOrCreateSubCategory(restaurantId, categoryId, subCategoryName = 'All Items') {
  const subCategoriesRef = collection(db, `restaurants/${restaurantId}/menu/data/categories/${categoryId}/subcategories`)
  
  const q = query(
    subCategoriesRef,
    where('name', '==', subCategoryName),
    where('active', '==', true),
    limit(1)
  )
  const snapshot = await getDocs(q)
  
  if (!snapshot.empty) {
    const subCategory = snapshot.docs[0]
    console.log(`✅ Found existing subcategory: "${subCategoryName}" (ID: ${subCategory.id})`)
    return subCategory.id
  }
  
  const allSubCategoriesQuery = query(
    subCategoriesRef,
    where('active', '==', true)
  )
  const allSubCategoriesSnapshot = await getDocs(allSubCategoriesQuery)
  const maxOrder = allSubCategoriesSnapshot.empty 
    ? 0 
    : Math.max(...allSubCategoriesSnapshot.docs.map(doc => doc.data().display_order || 0))
  
  const newSubCategoryRef = await addDoc(subCategoriesRef, {
    name: subCategoryName,
    description: null,
    display_order: maxOrder + 1,
    active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  
  console.log(`✅ Created new subcategory: "${subCategoryName}" (ID: ${newSubCategoryRef.id})`)
  return newSubCategoryRef.id
}

async function uploadMenuItems(restaurantId) {
  console.log(`🚀 Starting bulk upload for restaurant: ${restaurantId}`)
  console.log(`📦 Total items to upload: ${drinkMenuData.length}\n`)
  
  const itemsByCategory = {}
  drinkMenuData.forEach(item => {
    if (!itemsByCategory[item.category]) {
      itemsByCategory[item.category] = []
    }
    itemsByCategory[item.category].push(item)
  })
  
  console.log(`📋 Categories found: ${Object.keys(itemsByCategory).length}\n`)
  
  let totalUploaded = 0
  let totalErrors = 0
  
  for (const [categoryName, items] of Object.entries(itemsByCategory)) {
    console.log(`\n📂 Processing category: "${categoryName}" (${items.length} items)`)
    
    try {
      const categoryId = await getOrCreateMenuCategory(restaurantId, categoryName)
      const subCategoryId = await getOrCreateSubCategory(restaurantId, categoryId, 'All Items')
      
      for (const item of items) {
        try {
          const itemsRef = collection(
            db,
            `restaurants/${restaurantId}/menu/data/categories/${categoryId}/subcategories/${subCategoryId}/items`
          )
          
          const basePrice = typeof item.price === 'string' ? parseFloat(item.price) : Number(item.price)
          
          if (isNaN(basePrice)) {
            throw new Error(`Invalid price: ${item.price}`)
          }
          
          await addDoc(itemsRef, {
            name: item.name,
            description: '',
            image_url: item.imageUrl || null,
            base_price: basePrice,
            has_sizes: false,
            sizes: [],
            has_addons: false,
            addons: [],
            allow_special_instructions: true,
            status: 'available',
            times_ordered: 0,
            total_revenue: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          
          console.log(`  ✅ Uploaded: "${item.name}" - $${basePrice}`)
          totalUploaded++
        } catch (error) {
          console.error(`  ❌ Failed to upload "${item.name}":`, error.message)
          totalErrors++
        }
      }
    } catch (error) {
      console.error(`❌ Error processing category "${categoryName}":`, error.message)
      totalErrors += items.length
    }
  }
  
  console.log(`\n\n✨ Upload Complete!`)
  console.log(`✅ Successfully uploaded: ${totalUploaded} items`)
  if (totalErrors > 0) {
    console.log(`❌ Errors: ${totalErrors} items`)
  }
}

async function main() {
  try {
    const user = await authenticate()
    const restaurant = await findRestaurantByEmailOrName(user.email, 'Balcony Mix')
    await uploadMenuItems(restaurant.id)
    
    console.log('\n🎉 Script completed successfully!')
    console.log('\n📝 Next Steps:')
    console.log('   1. Check your menu management page to verify items were uploaded')
    console.log('   2. Ensure online_ordering_enabled is set to true in your restaurant settings')
    console.log('   3. Verify at least one payment method is enabled in /settings')
    process.exit(0)
  } catch (error) {
    console.error('\n💥 Script failed:', error.message)
    process.exit(1)
  }
}

main()
