# Public Routes Verification Guide

## Changes Made

### 1. Middleware Update (`middleware.ts`)
- **Changed**: Updated matcher to use negative pattern matching
- **Why**: Explicitly excludes public routes from middleware processing
- **Result**: Middleware NEVER runs on `/menu/*` routes, preventing any auth redirects

**Before**: Middleware checked routes and allowed them through
**After**: Middleware explicitly excludes public routes via negative matcher pattern

### 2. Centralized Base URL (`lib/base-url.ts`)
- **Created**: New utility module for base URL management
- **Why**: Ensures QR codes always point to production, never preview deployments
- **Features**:
  - `getBaseUrl()` - Gets base URL with fallbacks
  - `getQRCodeBaseUrl()` - Gets base URL for QR codes (throws error if not set in production)
  - `buildMenuUrl()` - Builds menu URLs with restaurant ID and optional table number

### 3. QR Code Generation (`components/qr-code-management.tsx`)
- **Changed**: Now uses centralized `buildMenuUrl()` utility
- **Why**: Ensures all QR codes use production URL from `NEXT_PUBLIC_BASE_URL`
- **Result**: QR codes always point to production domain

## Public Routes (No Authentication Required)

These routes are **excluded from middleware** and have **no auth checks**:

✅ `/menu/[restaurantId]` - Restaurant landing page
✅ `/menu/[restaurantId]/browse` - Menu browsing
✅ `/menu/[restaurantId]/cart` - Shopping cart
✅ `/menu/[restaurantId]/checkout` - Checkout page
✅ `/menu/[restaurantId]/order-confirmation/[orderId]` - Order confirmation
✅ `/signin` - Sign in page
✅ `/signup` - Sign up page
✅ `/forgot-password` - Password reset

## Protected Routes (Authentication Required)

These routes are **processed by middleware** and use `ProtectedRoute` component:

🔒 `/` - Admin home
🔒 `/dashboard` - Orders dashboard
🔒 `/menu-management` - Menu management
🔒 `/analytics` - Analytics dashboard
🔒 `/qr-codes` - QR code management
🔒 `/settings` - Settings

## Verification Steps

### 1. Test Public Routes (Incognito Window)
```bash
# Open incognito/private browser window
# Navigate to: https://your-app.vercel.app/menu/[restaurantId]?table=7

# Expected: Menu loads without login prompt
# Should see: Restaurant name, menu items, ability to add to cart
```

### 2. Test Protected Routes (Incognito Window)
```bash
# Navigate to: https://your-app.vercel.app/dashboard

# Expected: Redirect to /signin
# After login: Can access dashboard
```

### 3. Verify QR Code URLs
```bash
# In QR Codes management page, check generated QR codes
# URLs should be: https://your-production-domain.com/menu/[restaurantId]?table=X
# NOT: https://preview-deployment.vercel.app/...
```

## Environment Variables Required

### Vercel Environment Variables

Set in Vercel Dashboard → Settings → Environment Variables:

```
NEXT_PUBLIC_BASE_URL=https://your-production-domain.vercel.app
```

**Important**: 
- Must be set to production domain
- Should NOT include trailing slash
- Example: `https://tap-n-munch.vercel.app`

### Verification

The app will:
- ✅ Use `NEXT_PUBLIC_BASE_URL` if set
- ⚠️ Log warning if not set in production
- ❌ Throw error when generating QR codes if not set in production

## Potential Issues & Solutions

### Issue: Still getting redirected to Vercel login

**Cause**: Vercel Authentication is enabled in Vercel Dashboard

**Solution**:
1. Go to Vercel Dashboard → Project Settings → Authentication
2. **Disable** Vercel Authentication
3. The app uses Firebase Auth internally, not Vercel Auth

### Issue: QR codes point to preview deployments

**Cause**: `NEXT_PUBLIC_BASE_URL` not set

**Solution**:
1. Set `NEXT_PUBLIC_BASE_URL` in Vercel environment variables
2. Redeploy the application
3. Regenerate QR codes

### Issue: Menu pages require login

**Cause**: Middleware or component-level auth check

**Solution**:
1. Verify middleware matcher excludes `/menu/*`
2. Verify menu pages don't use `ProtectedRoute`
3. Check for client-side redirects in menu components

## Code Locations

- **Middleware**: `middleware.ts`
- **Base URL Utility**: `lib/base-url.ts`
- **QR Code Generation**: `components/qr-code-management.tsx`
- **Protected Route Component**: `components/auth/protected-route.tsx`
- **Menu Pages**: `app/menu/[restaurantId]/*`

## Testing Checklist

- [ ] Public menu routes load in incognito without login
- [ ] QR codes point to production domain
- [ ] Admin routes redirect to login when not authenticated
- [ ] Admin routes accessible after login
- [ ] No console errors about missing base URL in production
- [ ] QR codes work when scanned on new devices














