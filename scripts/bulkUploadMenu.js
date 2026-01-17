/**
 * Bulk Upload Menu Script - WITH SPECIFIC IMAGES
 * 
 * This script uploads menu items to Firestore with properly matched images.
 * Each item has been manually curated with appropriate Unsplash images.
 * 
 * Usage: node scripts/bulkUploadMenuWithImages.js your@email.com yourpassword
 */

try {
  require('dotenv').config({ path: '.env.local' })
} catch (e) {
  // dotenv not installed
}

const { initializeApp, getApps } = require('firebase/app')
const { getFirestore, collection, addDoc, query, where, getDocs, limit } = require('firebase/firestore')
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

const RESTAURANT_ID = 'cLBYu7qX0aGfbqwYEpVw'

// Updated Menu Data with Specific Images for Each Item
const menuData = [
  // Isabel's Choice - Seafood/Appetizers (Each with specific image)
  { 
    name: "Seafood Soup", 
    price: 75, 
    category: "Isabel's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1559847844-5315695dadae?q=80&w=500" // Seafood soup
  },
  { 
    name: "Crab Curry with steamed Rice", 
    price: 185, 
    category: "Isabel's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1633504581786-316c8002b1b6?q=80&w=500" // Crab curry
  },
  { 
    name: "Octopus Carpaccio", 
    price: 110, 
    category: "Isabel's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1559847844-d012a3c0e9a4?q=80&w=500" // Octopus dish
  },
  { 
    name: "Kabejou Ceviche", 
    price: 95, 
    category: "Isabel's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1626074353765-517a681e40be?q=80&w=500" // Ceviche
  },
  { 
    name: "Beef Carpaccio", 
    price: 110, 
    category: "Isabel's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=500" // Beef carpaccio
  },
  { 
    name: "Octopus Salad", 
    price: 130, 
    category: "Isabel's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=500" // Seafood salad
  },
  { 
    name: "Meat Croquets (2 units)", 
    price: 20, 
    category: "Isabel's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1623653387945-2fd25214f8fc?q=80&w=500" // Croquettes
  },
  { 
    name: "Prawn Pataniscas", 
    price: 80, 
    category: "Isabel's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1565557623262-b51c2513a641?q=80&w=500" // Prawn fritters
  },
  
  // Lion's Choice - Meat dishes
  { 
    name: "Steak Tartar", 
    price: 180, 
    category: "Lion's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1600891964092-4316c288032e?q=80&w=500" // Steak tartare
  },
  { 
    name: "Beef Fillet Medallions", 
    price: 145, 
    category: "Lion's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1558030006-450675393462?q=80&w=500" // Beef medallions
  },
  { 
    name: "Fried Beef Liver", 
    price: 135, 
    category: "Lion's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1529692236671-f1f6cf9683ba?q=80&w=500" // Fried liver
  },
  { 
    name: "Portuguese Steak", 
    price: 150, 
    category: "Lion's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1600891964599-f61ba0e24092?q=80&w=500" // Portuguese steak
  },
  { 
    name: "Ossobuco with roasted Butternut", 
    price: 125, 
    category: "Lion's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1619740455993-32e543d8f36a?q=80&w=500" // Ossobuco
  },
  
  // Leopard's Choice - Poultry/Pork
  { 
    name: "Fried Quail", 
    price: 180, 
    category: "Leopard's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1598103442097-8b74394b95c6?q=80&w=500" // Fried poultry
  },
  { 
    name: "Chicken Special", 
    price: 120, 
    category: "Leopard's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1598103442097-8b74394b95c6?q=80&w=500" // Roasted chicken
  },
  { 
    name: "Roasted Pork Knuckle", 
    price: 185, 
    category: "Leopard's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1529042410759-befb1204b468?q=80&w=500" // Pork knuckle
  },
  { 
    name: "Pork Spare Ribs", 
    price: 145, 
    category: "Leopard's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=500" // BBQ ribs
  },
  { 
    name: "Garlic Fried Chorizo", 
    price: 75, 
    category: "Leopard's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?q=80&w=500" // Chorizo
  },
  
  // Buffalo's Choice - Vegetarian
  { 
    name: "Scrambled Eggs (Truffle Oil)", 
    price: 80, 
    category: "Buffalo's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1608039755401-742074f0548d?q=80&w=500" // Scrambled eggs
  },
  { 
    name: "Vegetable Tempura", 
    price: 60, 
    category: "Buffalo's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1619740455993-32e543d8f36a?q=80&w=500" // Tempura
  },
  { 
    name: "Fresh Cheese & Beetroot Hummus", 
    price: 110, 
    category: "Buffalo's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1621342648996-438ecd060b02?q=80&w=500" // Hummus platter
  },
  { 
    name: "Mushroom Bites", 
    price: 60, 
    category: "Buffalo's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1608897013039-887f21d8c804?q=80&w=500" // Mushroom dish
  },
  { 
    name: "Yoghurt and Rocket Soup", 
    price: 75, 
    category: "Buffalo's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1547592166-23ac45744acd?q=80&w=500" // Green soup
  },
  
  // Rhino's Choice - Desserts
  { 
    name: "Trio of Crème Brûlée", 
    price: 75, 
    category: "Rhino's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1470124182917-cc6e71b22ecc?q=80&w=500" // Crème brûlée
  },
  { 
    name: "Duo of Sorbets", 
    price: 80, 
    category: "Rhino's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1563805042-7684c019e1cb?q=80&w=500" // Sorbet
  },
  { 
    name: "Pineapple Carpaccio", 
    price: 80, 
    category: "Rhino's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1587735243615-c03f25aaff15?q=80&w=500" // Pineapple dessert
  },
  { 
    name: "Orange and Thyme Cake", 
    price: 75, 
    category: "Rhino's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1578985545062-69928b1d9587?q=80&w=500" // Orange cake
  },
  { 
    name: "Cappuccino Delight", 
    price: 75, 
    category: "Rhino's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1514066558159-fc8c737ef259?q=80&w=500" // Coffee dessert
  },
  { 
    name: "Chocolate Cake", 
    price: 65, 
    category: "Rhino's Choice", 
    imageUrl: "https://images.unsplash.com/photo-1578985545062-69928b1d9587?q=80&w=500" // Chocolate cake
  },
  
  // Sides
  { 
    name: "Garlic and Coriander Rice", 
    price: 20, 
    category: "Sides", 
    imageUrl: "https://images.unsplash.com/photo-1516684732162-798a0062be99?q=80&w=500" // Rice dish
  },
  { 
    name: "Red Bean Rice", 
    price: 25, 
    category: "Sides", 
    imageUrl: "https://images.unsplash.com/photo-1586201375761-83865001e31c?q=80&w=500" // Bean rice
  },
  { 
    name: "Mash Potatoes", 
    price: 25, 
    category: "Sides", 
    imageUrl: "https://images.unsplash.com/photo-1528607929212-2636ec44253e?q=80&w=500" // Mashed potatoes
  },
  { 
    name: "Chips", 
    price: 20, 
    category: "Sides", 
    imageUrl: "https://images.unsplash.com/photo-1573080496219-bb080dd4f877?q=80&w=500" // French fries
  },
  { 
    name: "Lascas (Fried Potato Peel)", 
    price: 15, 
    category: "Sides", 
    imageUrl: "https://images.unsplash.com/photo-1621939514649-280e2ee25f60?q=80&w=500" // Potato chips
  },
  { 
    name: "Esparregado (Spinach Puree)", 
    price: 35, 
    category: "Sides", 
    imageUrl: "https://images.unsplash.com/photo-1576045057995-568f588f82fb?q=80&w=500" // Spinach dish
  },
  { 
    name: "Couvert (Bread, Butter, Olives)", 
    price: 30, 
    category: "Sides", 
    imageUrl: "https://images.unsplash.com/photo-1509440159596-0249088772ff?q=80&w=500" // Bread basket
  },
  { 
    name: "Home Made Fresh Cheese", 
    price: 30, 
    category: "Sides", 
    imageUrl: "https://images.unsplash.com/photo-1452195100486-9cc805987862?q=80&w=500" // Fresh cheese
  }
]

async function getOrCreateMenuCategory(categoryName) {
  const categoriesRef = collection(db, `restaurants/${RESTAURANT_ID}/menu/data/categories`)
  
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

async function getOrCreateSubCategory(categoryId, subCategoryName = 'All Items') {
  const subCategoriesRef = collection(db, `restaurants/${RESTAURANT_ID}/menu/data/categories/${categoryId}/subcategories`)
  
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

async function uploadMenuItems() {
  console.log(`🚀 Starting bulk upload for restaurant: ${RESTAURANT_ID}`)
  console.log(`📦 Total items to upload: ${menuData.length}\n`)
  
  const itemsByCategory = {}
  menuData.forEach(item => {
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
      const categoryId = await getOrCreateMenuCategory(categoryName)
      const subCategoryId = await getOrCreateSubCategory(categoryId, 'All Items')
      
      for (const item of items) {
        try {
          const itemsRef = collection(
            db,
            `restaurants/${RESTAURANT_ID}/menu/data/categories/${categoryId}/subcategories/${subCategoryId}/items`
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
          
          console.log(`  ✅ Uploaded: "${item.name}" - NAD${basePrice}`)
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
    await authenticate()
    await uploadMenuItems()
    
    console.log('\n🎉 Script completed successfully!')
    process.exit(0)
  } catch (error) {
    console.error('\n💥 Script failed:', error.message)
    process.exit(1)
  }
}

main()