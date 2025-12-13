# Firebase Storage Setup Guide

## Quick Fix for CORS Error

If you're seeing a CORS error when uploading images, follow these steps:

### Step 1: Enable Firebase Storage

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Click **Storage** in the left sidebar
4. If you see "Get started", click it and follow the setup wizard
5. Choose **Start in production mode**
6. Select a location (same as your Firestore region)
7. Click **Done**

### Step 2: Set Up Storage Security Rules

1. In Firebase Console, go to **Storage**
2. Click **Rules** tab
3. Replace the default rules with the rules from `storage.rules` file in this project
4. Click **Publish**

### Step 3: Verify Authentication

Make sure you're signed in to your restaurant account when trying to upload images. The upload will fail if you're not authenticated.

### Step 4: Test Upload

1. Go to Menu Management
2. Select a sub-category
3. Click "Add Item"
4. Try uploading an image

## Alternative: Deploy Rules via CLI

If you have Firebase CLI installed:

```bash
# Make sure you're in the project root
cd restaurant-menu-screen

# Deploy storage rules
firebase deploy --only storage
```

## Troubleshooting

### Still Getting CORS Error?

1. **Check if Storage is enabled**: Go to Firebase Console → Storage. You should see a storage bucket.
2. **Check if rules are published**: Go to Storage → Rules. Make sure your rules are saved and published.
3. **Check authentication**: Make sure you're signed in. Try signing out and back in.
4. **Clear browser cache**: Sometimes cached rules can cause issues.
5. **Check browser console**: Look for more detailed error messages.

### "Permission denied" Error

- Make sure you're signed in
- Make sure Storage rules allow authenticated users to write
- Check that the file size is under 5MB
- Check that the file is an image (jpg, png, gif, etc.)

### Upload Works But Image Doesn't Show

- Check that the image URL is saved correctly in Firestore
- Verify the image URL is accessible (try opening it in a new tab)
- Check browser console for image loading errors

## Storage Rules Explained

The storage rules allow:
- **Read**: Anyone can view images (for customer menus)
- **Write**: Authenticated users can upload images (max 5MB, images only)
- **Delete**: Only restaurant owners can delete their own images

This ensures:
- Customers can see menu item images
- Only authenticated restaurant owners can upload
- Images are properly validated (size and type)
- Restaurant data is isolated

