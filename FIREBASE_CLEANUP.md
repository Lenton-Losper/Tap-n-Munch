# Firebase Cleanup Guide

## Understanding Firebase Services

Firebase has **two separate services** for user management:

1. **Firebase Authentication** - Stores user credentials (email/password)
2. **Firestore Database** - Stores user documents and application data

**Important:** Deleting data from Firestore does NOT delete users from Firebase Authentication!

## Why You Can Still Log In

When you delete all Firestore data:
- ✅ Firebase Auth users still exist
- ✅ You can still sign in with email/password
- ❌ But your Firestore user document is missing
- ❌ Your restaurant data is missing
- ❌ The app won't work properly (no restaurant_id)

## How to Fully Delete a User

### Option 1: Delete from Firebase Console (Recommended)

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project: **FlashTap**
3. Click **Authentication** in the left menu
4. Click the **Users** tab
5. Find the user you want to delete
6. Click the **three dots (⋮)** next to the user
7. Click **Delete user**
8. Confirm deletion

### Option 2: Delete All Users at Once

1. Go to **Authentication** → **Users**
2. Select all users (checkbox at top)
3. Click **Delete selected**
4. Confirm deletion

## Complete Fresh Start

To completely reset your Firebase project:

### Step 1: Delete All Firestore Data
1. Go to **Firestore Database** → **Data** tab
2. Delete all collections manually, OR
3. Use the Firebase CLI:
   ```bash
   # WARNING: This deletes ALL data!
   firebase firestore:delete --all-collections
   ```

### Step 2: Delete All Auth Users
1. Go to **Authentication** → **Users**
2. Delete all users (see Option 2 above)

### Step 3: (Optional) Reset Security Rules
1. Go to **Firestore Database** → **Rules** tab
2. Deploy the rules from `firestore.rules` file

### Step 4: (Optional) Reset Indexes
1. Go to **Firestore Database** → **Indexes** tab
2. Delete any existing indexes, OR
3. Deploy indexes from `firestore.indexes.json`:
   ```bash
   firebase deploy --only firestore:indexes
   ```

## What Happens When You Sign In After Deleting Firestore Data

When you sign in after deleting Firestore data:

1. ✅ **Authentication succeeds** - Firebase Auth still has your user
2. ❌ **User document missing** - Firestore `users` collection is empty
3. ❌ **Restaurant data missing** - No restaurant_id available
4. ⚠️ **App won't work** - Dashboard will show errors or empty states

The app will detect this and set:
- `userData = null`
- `restaurant = null`
- `restaurantId = null`

You'll need to either:
- **Sign up again** (creates new Auth user + Firestore data)
- **Delete the Auth user** and sign up fresh

## Testing After Cleanup

After deleting everything:

1. **Sign up with a new account** - Should create:
   - ✅ Firebase Auth user
   - ✅ User document in Firestore
   - ✅ Restaurant document
   - ✅ Default categories

2. **Verify in Firebase Console:**
   - Authentication → Users (should have 1 user)
   - Firestore → Data (should have collections: users, restaurants, categories)

## Quick Reset Script (Firebase CLI)

If you have Firebase CLI installed, you can create a reset script:

```bash
#!/bin/bash
# reset-firebase.sh

echo "⚠️  WARNING: This will delete ALL data!"
read -p "Are you sure? (yes/no): " confirm

if [ "$confirm" != "yes" ]; then
  echo "Cancelled."
  exit 1
fi

echo "Deleting Firestore data..."
firebase firestore:delete --all-collections --yes

echo "⚠️  You still need to manually delete Auth users from Firebase Console"
echo "Go to: Authentication → Users → Delete all users"
```

## Best Practice

For development/testing:
- Use separate Firebase projects for dev/staging/production
- Or use Firebase Emulator Suite for local development
- Don't delete production data!

