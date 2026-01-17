/**
 * Update Menu Item Images Script
 * 
 * This script updates existing menu items in Firestore with correct images.
 * 
 * Usage: node scripts/updateMenuImages.js your@email.com yourpassword
 */

try {
  require('dotenv').config({ path: '.env.local' })
} catch (e) {
  // dotenv not installed
}

const { initializeApp, getApps } = require('firebase/app')
const { getFirestore, collection, getDocs, doc, updateDoc, query, where } = require('firebase/firestore')
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

// Category-based image mapping: category name → generic high-quality image URL
const categoryImageMapping = {
  "Isabel's Choice": "https://images.unsplash.com/photo-1534080564617-307be2416f40?q=80&w=500", // Seafood
  "Lion's Choice": "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=500", // Meat/Steaks
  "Leopard's Choice": "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=500", // Meat/Poultry
  "Buffalo's Choice": "https://images.unsplash.com/photo-1540189549336-e6e99c3679fe?q=80&w=500", // Vegetarian
  "Rhino's Choice": "https://images.unsplash.com/photo-1551024601-bec78aea704b?q=80&w=500", // Desserts
  "Sides": "https://images.unsplash.com/photo-1534422298391-e4f8c170db06?q=80&w=500" // Sides
}

// Specific item image mapping (for items that need specific images)
const specificImageMapping = {
  // Isabel's Choice - Seafood/Appetizers
  "Seafood Soup": "https://images.unsplash.com/photo-1559847844-5315695dadae?q=80&w=500",
  "Crab Curry with steamed Rice": "https://images.unsplash.com/photo-1633504581786-316c8002b1b6?q=80&w=500",
  "Octopus Carpaccio": "https://images.unsplash.com/photo-1559847844-d012a3c0e9a4?q=80&w=500",
  "Kabejou Ceviche": "https://images.unsplash.com/photo-1626074353765-517a681e40be?q=80&w=500",
  "Beef Carpaccio": "https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=500",
  "Octopus Salad": "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?q=80&w=500",
  "Meat Croquets (2 units)": "https://images.unsplash.com/photo-1623653387945-2fd25214f8fc?q=80&w=500",
  "Prawn Pataniscas": "https://images.unsplash.com/photo-1565557623262-b51c2513a641?q=80&w=500",
  
  // Lion's Choice - Meat dishes
  "Steak Tartar": "https://images.unsplash.com/photo-1600891964092-4316c288032e?q=80&w=500",
  "Beef Fillet Medallions": "https://images.unsplash.com/photo-1558030006-450675393462?q=80&w=500",
  "Fried Beef Liver": "https://images.unsplash.com/photo-1529692236671-f1f6cf9683ba?q=80&w=500",
  "Portuguese Steak": "https://images.unsplash.com/photo-1600891964599-f61ba0e24092?q=80&w=500",
  "Ossobuco with roasted Butternut": "https://images.unsplash.com/photo-1619740455993-32e543d8f36a?q=80&w=500",
  
  // Leopard's Choice - Poultry/Pork
  "Fried Quail": "https://images.unsplash.com/photo-1598103442097-8b74394b95c6?q=80&w=500",
  "Chicken Special": "https://images.unsplash.com/photo-1598103442097-8b74394b95c6?q=80&w=500",
  "Roasted Pork Knuckle": "https://images.unsplash.com/photo-1529042410759-befb1204b468?q=80&w=500",
  "Pork Spare Ribs": "https://images.unsplash.com/photo-1544025162-d76694265947?q=80&w=500",
  "Garlic Fried Chorizo": "https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?q=80&w=500",
  
  // Buffalo's Choice - Vegetarian
  "Scrambled Eggs (Truffle Oil)": "https://images.unsplash.com/photo-1608039755401-742074f0548d?q=80&w=500",
  "Vegetable Tempura": "https://images.unsplash.com/photo-1619740455993-32e543d8f36a?q=80&w=500",
  "Fresh Cheese & Beetroot Hummus": "https://images.unsplash.com/photo-1621342648996-438ecd060b02?q=80&w=500",
  "Mushroom Bites": "https://images.unsplash.com/photo-1608897013039-887f21d8c804?q=80&w=500",
  "Yoghurt and Rocket Soup": "https://images.unsplash.com/photo-1547592166-23ac45744acd?q=80&w=500",
  
  // Rhino's Choice - Desserts
  "Trio of Crème Brûlée": "https://images.unsplash.com/photo-1470124182917-cc6e71b22ecc?q=80&w=500",
  "Duo of Sorbets": "https://images.unsplash.com/photo-1563805042-7684c019e1cb?q=80&w=500",
  "Pineapple Carpaccio": "https://images.unsplash.com/photo-1587735243615-c03f25aaff15?q=80&w=500",
  "Orange and Thyme Cake": "https://images.unsplash.com/photo-1578985545062-69928b1d9587?q=80&w=500",
  "Cappuccino Delight": "https://images.unsplash.com/photo-1514066558159-fc8c737ef259?q=80&w=500",
  "Chocolate Cake": "https://images.unsplash.com/photo-1578985545062-69928b1d9587?q=80&w=500",
  
  // Sides
  "Garlic and Coriander Rice": "https://images.unsplash.com/photo-1516684732162-798a0062be99?q=80&w=500",
  "Red Bean Rice": "https://images.unsplash.com/photo-1586201375761-83865001e31c?q=80&w=500",
  "Mash Potatoes": "https://images.unsplash.com/photo-1528607929212-2636ec44253e?q=80&w=500",
  "Chips": "https://images.unsplash.com/photo-1573080496219-bb080dd4f877?q=80&w=500",
  "Lascas (Fried Potato Peel)": "https://images.unsplash.com/photo-1621939514649-280e2ee25f60?q=80&w=500",
  "Esparregado (Spinach Puree)": "https://images.unsplash.com/photo-1576045057995-568f588f82fb?q=80&w=500",
  "Couvert (Bread, Butter, Olives)": "https://images.unsplash.com/photo-1509440159596-0249088772ff?q=80&w=500",
  "Home Made Fresh Cheese": "https://images.unsplash.com/photo-1452195100486-9cc805987862?q=80&w=500"
}

async function updateMenuItemImages() {
  console.log(`🚀 Starting image update for restaurant: ${RESTAURANT_ID}\n`)
  
  let totalUpdated = 0
  let totalNotFound = 0
  let totalErrors = 0
  let totalSkipped = 0
  
  // Get all categories
  // Correct path: restaurants/{id}/menu/data/categories (menu/data is a document)
  const categoriesRef = collection(db, `restaurants/${RESTAURANT_ID}/menu/data/categories`)
  const categoriesSnapshot = await getDocs(categoriesRef)
  
  console.log(`📂 Found ${categoriesSnapshot.size} categories\n`)
  
  // Loop through each category
  for (const categoryDoc of categoriesSnapshot.docs) {
    const categoryId = categoryDoc.id
    const categoryName = categoryDoc.data().name
    
    console.log(`📂 Processing category: ${categoryName}`)
    
    // Get all subcategories
    const subcategoriesRef = collection(
      db,
      `restaurants/${RESTAURANT_ID}/menu/data/categories/${categoryId}/subcategories`
    )
    const subcategoriesSnapshot = await getDocs(subcategoriesRef)
    
    // Loop through each subcategory
    for (const subcategoryDoc of subcategoriesSnapshot.docs) {
      const subcategoryId = subcategoryDoc.id
      const subcategoryName = subcategoryDoc.data().name
      
      // Get all items in this subcategory
      const itemsRef = collection(
        db,
        `restaurants/${RESTAURANT_ID}/menu/data/categories/${categoryId}/subcategories/${subcategoryId}/items`
      )
      const itemsSnapshot = await getDocs(itemsRef)
      
      // Update each item
      for (const itemDoc of itemsSnapshot.docs) {
        const itemData = itemDoc.data()
        const itemName = itemData.name
        const currentImageUrl = itemData.image_url
        
        // Try specific mapping first, then fall back to category-based mapping
        let newImageUrl = specificImageMapping[itemName]
        if (!newImageUrl && categoryImageMapping[categoryName]) {
          newImageUrl = categoryImageMapping[categoryName]
          console.log(`  📋 Using category image for: "${itemName}"`)
        }
        
        if (newImageUrl) {
          // Skip if image is already correct
          if (currentImageUrl === newImageUrl) {
            console.log(`  ⏭️  Skipped (already correct): "${itemName}"`)
            totalSkipped++
            continue
          }
          
          try {
            // Update the item
            await updateDoc(itemDoc.ref, {
              image_url: newImageUrl,
              updated_at: new Date().toISOString()
            })
            
            console.log(`  ✅ Updated: "${itemName}"`)
            if (currentImageUrl) {
              console.log(`     Old: ${currentImageUrl.substring(0, 50)}...`)
            }
            console.log(`     New: ${newImageUrl}`)
            totalUpdated++
          } catch (error) {
            console.error(`  ❌ Failed to update "${itemName}":`, error.message)
            totalErrors++
          }
        } else {
          console.log(`  ⚠️  No image mapping found for: "${itemName}" (category: ${categoryName})`)
          totalNotFound++
        }
      }
    }
  }
  
  console.log(`\n\n✨ Image Update Complete!`)
  console.log(`✅ Successfully updated: ${totalUpdated} items`)
  console.log(`⏭️  Skipped (already correct): ${totalSkipped} items`)
  if (totalNotFound > 0) {
    console.log(`⚠️  No mapping found: ${totalNotFound} items`)
  }
  if (totalErrors > 0) {
    console.log(`❌ Errors: ${totalErrors} items`)
  }
}

async function main() {
  try {
    await authenticate()
    await updateMenuItemImages()
    
    console.log('\n🎉 Script completed successfully!')
    process.exit(0)
  } catch (error) {
    console.error('\n💥 Script failed:', error.message)
    process.exit(1)
  }
}

main()

