# Route Protection Guide

## Overview

This application has two types of routes:

1. **Public Routes** - Accessible without authentication (customer-facing)
2. **Protected Routes** - Require authentication (staff/admin)

## Public Routes (No Authentication Required)

These routes are accessible to anyone, including unauthenticated users:

- `/menu/*` - All customer menu routes
  - `/menu/[restaurantId]` - Restaurant landing page
  - `/menu/[restaurantId]/browse` - Menu browsing
  - `/menu/[restaurantId]/cart` - Shopping cart
  - `/menu/[restaurantId]/checkout` - Checkout page
  - `/menu/[restaurantId]/order-confirmation/[orderId]` - Order confirmation
- `/signin` - Sign in page
- `/signup` - Sign up page
- `/forgot-password` - Password reset page

## Protected Routes (Authentication Required)

These routes require staff/admin authentication:

- `/` - Admin home/dashboard
- `/dashboard` - Live orders dashboard
- `/menu-management` - Menu management
- `/analytics` - Analytics dashboard
- `/qr-codes` - QR code management
- `/settings` - Settings

## How Protection Works

1. **Middleware** (`middleware.ts`):
   - Explicitly allows all `/menu/*` routes to pass through without authentication
   - Allows authentication pages (`/signin`, `/signup`, `/forgot-password`)
   - All other routes pass through to Next.js (protection happens at component level)

2. **Component-Level Protection** (`ProtectedRoute` component):
   - Admin routes wrap their content with `<ProtectedRoute>`
   - This component checks authentication and redirects to `/signin` if not authenticated
   - Customer routes do NOT use `ProtectedRoute`

## Important: Vercel Authentication

⚠️ **If you're experiencing redirects to a Vercel authentication page:**

Vercel has a built-in authentication feature that can be enabled in the Vercel dashboard. If this is enabled, it runs **BEFORE** Next.js middleware and will intercept all routes, including public customer routes.

**To fix this:**
1. Go to your Vercel project dashboard
2. Navigate to Settings → Authentication
3. **Disable Vercel Authentication** for this project
4. The application handles authentication internally via Firebase Auth

**Why this matters:**
- Customer routes (`/menu/*`) must be accessible without any authentication
- QR codes won't work if Vercel authentication is blocking unauthenticated users
- The app uses Firebase Auth for staff/admin authentication, not Vercel Auth

## Testing Public Routes

To verify customer routes are public:

1. Open an incognito/private browser window
2. Navigate directly to: `/menu/[restaurantId]?table=7`
3. You should see the restaurant menu without being asked to log in
4. You should be able to browse, add to cart, and checkout without authentication

## Testing Protected Routes

To verify admin routes are protected:

1. Open an incognito/private browser window
2. Navigate to: `/dashboard`
3. You should be redirected to `/signin`
4. After signing in, you should be able to access admin routes


















