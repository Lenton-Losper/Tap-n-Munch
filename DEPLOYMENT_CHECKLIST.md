# Deployment Checklist - Order Creation Fix

## ✅ Code Changes Completed

1. **Removed `customer_email` from order creation flow**
   - ✅ Removed from checkout page payload
   - ✅ Removed from API route
   - ✅ Added deep recursive cleaning
   - ✅ Added multiple validation guards

2. **Hardened Firestore writes**
   - ✅ All writes moved to server-side API route
   - ✅ Deep cleaning removes undefined values recursively
   - ✅ Forbidden fields removed at multiple stages
   - ✅ JSON round-trip sanitization
   - ✅ Final explicit deletion before `addDoc`

3. **Added comprehensive error handling**
   - ✅ Validation guards throw clear errors
   - ✅ Debug logging for troubleshooting
   - ✅ Client-side error handling

## 🚀 Deployment Steps

### 1. Commit and Push Changes
```bash
git add .
git commit -m "Fix: Remove customer_email from order creation, harden Firestore writes"
git push
```

### 2. Wait for Vercel Deployment
- Check Vercel dashboard for deployment status
- Wait for build to complete (usually 2-5 minutes)

### 3. Clear Browser Cache
**CRITICAL:** The browser has cached old JavaScript bundles!

**Option A: Hard Refresh**
- Windows: `Ctrl + Shift + R` or `Ctrl + F5`
- Mac: `Cmd + Shift + R`

**Option B: Clear Site Data**
1. Open DevTools (F12)
2. Go to Application tab
3. Click "Clear storage" in left sidebar
4. Check "Cache storage" and "Local storage"
5. Click "Clear site data"
6. Refresh page

**Option C: Incognito/Private Window**
- Open a new incognito/private window
- Test the order flow there

### 4. Test Order Creation
1. Navigate to checkout page
2. Add items to cart
3. Click "Place Order"
4. **Check browser console** - should see:
   - `🚀 CHECKOUT - Calling /api/orders with payload:`
   - `🚀 CHECKOUT - Response status: 201`
5. **Check server logs** (if testing locally) - should see:
   - `🔵 API ROUTE - Incoming request body keys:`
   - `🟢 API ROUTE - Final order keys:`
   - `✅ API ROUTE - Order created successfully:`

## 🔍 Verification

### Success Indicators
- ✅ Order is created in Firestore
- ✅ No `customer_email` field in Firestore document
- ✅ No undefined value errors
- ✅ Order appears in restaurant dashboard
- ✅ Redirect to confirmation page works

### If Error Persists

1. **Check Server Logs** (Vercel Dashboard → Functions → View Logs)
   - Look for `🔵 API ROUTE` logs
   - Check if `customer_email` appears in incoming request

2. **Check Browser Console**
   - Look for `🚀 CHECKOUT` logs
   - Check network tab for `/api/orders` request/response

3. **Verify Deployment**
   - Check Vercel deployment logs for build errors
   - Verify latest commit is deployed

## 📝 Files Changed

- `app/api/orders/route.ts` - Server-side order creation with deep cleaning
- `app/menu/[restaurantId]/checkout/page.tsx` - Client-side payload sanitization
- `lib/firebase/orders.ts` - Removed customer_email from createOrder (if used)

## 🎯 Expected Behavior After Deployment

1. User clicks "Place Order"
2. Frontend sends clean payload to `/api/orders` (no customer_email)
3. API route deep cleans the data
4. API route removes any customer_email that might exist
5. API route writes to Firestore (no customer_email, no undefined)
6. Order created successfully
7. User redirected to confirmation page

## ⚠️ Important Notes

- **Browser cache must be cleared** - old JavaScript bundles will cause errors
- **Vercel deployment required** - local changes won't affect production
- **Test in incognito window** - ensures no cached code

