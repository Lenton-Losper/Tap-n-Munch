# Testing Guide - FlashTap

## 🚀 Quick Start Testing

### 1. **Access the Application**
- Open: `http://localhost:3000` (or `http://localhost:3001` if port 3000 is in use)
- You should be redirected to `/signin` if not logged in

### 2. **Create a Restaurant Account**
1. Go to `/signup`
2. Fill in:
   - Restaurant Name: "Test Restaurant"
   - Email: your-email@example.com
   - Phone: +264812345678
   - Password: (min 8 chars, uppercase, lowercase, number)
3. Click "Start Free Trial"
4. You'll be auto-logged in and redirected to the homepage

### 3. **Set Up Your Restaurant (First Time)**

#### Create Categories
Before adding menu items, you need categories. For now, you can:
- Use Firebase Console to manually add categories, OR
- The system will work but you'll need at least one category

**To add a category via Firebase Console:**
1. Go to Firebase Console → Firestore Database
2. Navigate to `categories` collection
3. Add a document with:
   ```json
   {
     "restaurant_id": "your-user-id",
     "name": "Starters",
     "display_order": 1,
     "active": true,
     "created_at": "2025-01-25T..."
   }
   ```

#### Add Menu Items
1. Go to `/menu-management`
2. Click "Add Item"
3. Fill in:
   - Item Name: "Grilled Chicken"
   - Description: "Tender grilled chicken"
   - Category: Select your category
   - Price: 145.00
   - Status: Available
4. Click "Create Item"

### 4. **Create Tables & QR Codes**
1. Go to `/qr-codes`
2. Click "Add Table"
3. Enter table number (e.g., 7)
4. Optional: Add location
5. Click "Create Table"
6. Copy the QR code link or download it

### 5. **Test Customer Flow**

#### Option A: Use QR Code Link
1. Copy a table QR code URL (e.g., `http://localhost:3000/menu/YOUR_RESTAURANT_ID?table=7`)
2. Open in a new browser/incognito window (to simulate a customer)
3. You should see the restaurant landing page

#### Option B: Direct Menu Access
1. Go to `/menu/YOUR_RESTAURANT_ID?table=7`
2. Click "View Menu"
3. Browse menu items
4. Click "Add +" on an item
5. Customize if needed (sizes, addons)
6. Add to cart
7. Go to cart, review items
8. Proceed to checkout
9. Fill customer info (optional)
10. Select payment method
11. Place order

### 6. **Test Restaurant Dashboard**

#### View Orders
1. Go to `/dashboard`
2. You should see the order you just placed in the "New" tab
3. Click "Accept & Start" to move it to "Accepted"
4. Click "Start Preparing" to move to "Preparing"
5. Click "Mark as Ready" to move to "Ready"
6. Click "Complete Order" to finish

#### Check Customer View
1. Go back to the order confirmation page
2. You should see the status update in real-time!

### 7. **Test Analytics**
1. Go to `/analytics`
2. Select a date range
3. View:
   - Total sales
   - Total orders
   - Average order value
   - Revenue trends chart
   - Top selling items
   - Peak hours

### 8. **Test Menu Management**
1. Go to `/menu-management`
2. Edit an item
3. Change status (Available/Out of Stock)
4. Delete an item
5. Add new items

## 🔍 Common Issues & Solutions

### Issue: "No categories found"
**Solution:** Create at least one category in Firebase Console or add category creation UI

### Issue: "Firebase not configured"
**Solution:** Make sure `.env.local` has all Firebase credentials

### Issue: "No menu items"
**Solution:** Add menu items via `/menu-management`

### Issue: Orders not appearing
**Solution:** 
- Check Firebase Console → Firestore → `orders` collection
- Verify you're logged in as the restaurant owner
- Check browser console for errors

### Issue: Real-time updates not working
**Solution:**
- Check Firebase security rules allow reads
- Verify you're subscribed to the correct restaurant ID

## 📝 Testing Checklist

- [ ] Sign up as restaurant
- [ ] Create categories (via Firebase or UI)
- [ ] Add menu items
- [ ] Create tables
- [ ] Generate QR codes
- [ ] Place order as customer
- [ ] View order in restaurant dashboard
- [ ] Update order status
- [ ] See real-time status update on customer side
- [ ] View analytics
- [ ] Edit menu items
- [ ] Test search functionality
- [ ] Test cart functionality
- [ ] Test checkout process

## 🎯 Key Features to Test

1. **Authentication**
   - Sign up
   - Sign in
   - Sign out
   - Protected routes

2. **Menu Management**
   - CRUD operations
   - Category filtering
   - Search
   - Status toggles

3. **Ordering Flow**
   - Browse menu
   - Customize items
   - Add to cart
   - Checkout
   - Order placement

4. **Real-time Updates**
   - Order status changes
   - Live order dashboard

5. **Analytics**
   - Date range selection
   - Charts rendering
   - Statistics calculation

## 💡 Tips

- Use two browser windows: one for restaurant, one for customer
- Use incognito mode for customer testing
- Check browser console for any errors
- Check Firebase Console to see data being created
- Test on mobile view (responsive design)


