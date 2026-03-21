# Firebase Setup Guide

## Step 1: Get Your Firebase Configuration

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your **FlashTap** project
3. Click the **⚙️ Settings** icon (gear) → **Project settings**
4. Scroll down to **Your apps** section
5. If you don't have a web app yet:
   - Click **Add app** → Select **Web** (</> icon)
   - Register your app (nickname: "FlashTap Web")
   - Click **Register app**
6. Copy the `firebaseConfig` object values

## Step 2: Create Environment File

1. Create a file named `.env.local` in the root of your project
2. Copy the template below and fill in your values:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=your-api-key-here
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your-messaging-sender-id
NEXT_PUBLIC_FIREBASE_APP_ID=your-app-id
```

**Example:**
```env
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSyBxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=flashtap-fa58f.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=flashtap-fa58f
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=flashtap-fa58f.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=123456789012
NEXT_PUBLIC_FIREBASE_APP_ID=1:123456789012:web:abcdef123456
```

## Step 3: Enable Authentication

1. In Firebase Console, go to **Authentication**
2. Click **Get started**
3. Click **Sign-in method** tab
4. Click **Email/Password**
5. Toggle **Enable** to ON
6. Click **Save**

## Step 4: Enable Firebase Storage

1. In Firebase Console, go to **Storage**
2. Click **Get started**
3. Choose **Start in production mode** (we'll set up rules next)
4. Select a location for your storage bucket (choose the same region as your Firestore)
5. Click **Done**

## Step 5: Set Up Firestore Security Rules

1. In Firebase Console, go to **Firestore Database**
2. Click **Rules** tab
3. Replace the default rules with:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Restaurants can only access their own data
    match /restaurants/{restaurantId} {
      allow read, write: if request.auth != null 
        && request.auth.uid == restaurantId;
      
      // Menu items
      match /menuItems/{itemId} {
        allow read: if true; // Public read for customers
        allow write: if request.auth != null 
          && request.auth.uid == restaurantId;
      }
      
      // Orders
      match /orders/{orderId} {
        allow read: if request.auth != null 
          && request.auth.uid == restaurantId;
        allow create: if true; // Customers can create orders
        allow update: if request.auth != null 
          && request.auth.uid == restaurantId;
      }
      
      // Tables
      match /tables/{tableId} {
        allow read: if true; // Public for QR codes
        allow write: if request.auth != null 
          && request.auth.uid == restaurantId;
      }
    }
  }
}
```

4. Click **Publish**

## Step 6: Set Up Firebase Storage Security Rules

1. In Firebase Console, go to **Storage**
2. Click **Rules** tab
3. Replace the default rules with:

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    
    // Helper function to get restaurant owner_id from Firestore
    function getRestaurantOwner(restaurantId) {
      return firestore.get(/databases/(default)/documents/restaurants/$(restaurantId)).data.owner_id;
    }
    
    // Helper function to check if user is restaurant owner
    function isRestaurantOwner(restaurantId) {
      return request.auth != null && 
             request.auth.uid == getRestaurantOwner(restaurantId);
    }
    
    // Menu item images: Only restaurant owners can upload/delete
    match /menu-items/{restaurantId}/{fileName} {
      // Allow read by anyone (for customer menus)
      allow read: if true;
      
      // Allow upload by authenticated users (will be validated by Firestore rules)
      allow write: if request.auth != null
        && request.resource.size < 5 * 1024 * 1024  // Max 5MB
        && request.resource.contentType.matches('image/.*');  // Only images
      
      // Allow delete by restaurant owner
      allow delete: if request.auth != null && isRestaurantOwner(restaurantId);
    }
    
    // Default: Deny all other access
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
```

4. Click **Publish**

**Note**: If you prefer to deploy rules using Firebase CLI, you can use:
```bash
firebase deploy --only storage
```

## Step 7: Create Firestore Indexes

Firestore requires composite indexes for queries that filter on multiple fields or combine filters with ordering.

### Quick Fix (Recommended)
When you see an index error in the console:
1. **Click the link** in the error message - it will open Firebase Console with the index pre-configured
2. Click **"Create Index"** 
3. Wait 2-5 minutes for the index to build

### Using Firebase CLI (Alternative)
If you have Firebase CLI installed:

```bash
# Install Firebase CLI (if not already installed)
npm install -g firebase-tools

# Login to Firebase
firebase login

# Initialize Firestore (if not already done)
firebase init firestore

# Deploy indexes
firebase deploy --only firestore:indexes
```

The project includes a `firestore.indexes.json` file with the required indexes.

## Step 8: Test the Setup

After completing the above steps, restart your dev server:

```bash
npm run dev
```

The Firebase connection should now be working! 🎉

## Troubleshooting

### "The query requires an index" Error
- **Solution**: Click the link in the error message to create the index automatically
- Or deploy indexes using: `firebase deploy --only firestore:indexes`
- Indexes take 2-5 minutes to build after creation

### CORS Error When Uploading Images
- **Solution**: Make sure Firebase Storage is enabled and security rules are published
- Go to Firebase Console → Storage → Rules
- Copy and paste the rules from Step 6 above
- Click **Publish**
- Make sure you're signed in when trying to upload images

## Server / API routes: Firebase Admin (recommended)

Order creation (`/api/orders`), PayCloud webhooks, and receipt payment verification use **Firestore from the server**. The client SDK is unauthenticated there, so you should use a **service account** to avoid permission errors and to keep payment updates secure.

1. Firebase Console → **Project settings** → **Service accounts** → **Generate new private key**.
2. In Vercel (or `.env.local` for local API routes), add:

```env
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"...", ... }
```

Paste the **entire JSON on one line** (or minified). The app reads this in `lib/firebase/admin-firestore.ts`.

If this variable is **not** set, `/api/orders` falls back to the browser Firebase config (still subject to security rules).

## Next Steps

- ✅ Firebase is now installed and configured
- ⏭️ Next: Create login/signup pages
- ⏭️ Then: Connect menu items to Firestore
- ⏭️ Then: Connect orders to Firestore

