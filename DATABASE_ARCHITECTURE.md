# Database Architecture & Data Isolation

## Overview

This document describes the complete database architecture for the Tap n Munch restaurant QR ordering platform, with emphasis on user-specific data isolation.

## Database Schema

All types are defined in `lib/firebase/types.ts`. See that file for complete interface definitions.

### Collections

1. **users** - User accounts (Firebase Auth + Firestore)
2. **restaurants** - Restaurant profiles
3. **categories** - Menu categories (per restaurant)
4. **menu_items** - Menu items (per restaurant)
5. **tables** - Table/QR code management (per restaurant)
6. **orders** - Customer orders (per restaurant)
7. **analytics_daily** - Daily analytics (per restaurant)

## Data Isolation Rules

### CRITICAL: All queries MUST filter by restaurant_id

Every query that fetches data must include a filter on `restaurant_id` to ensure users only see their own data.

**✅ CORRECT:**
```typescript
const items = await getMenuItems(restaurantId, categoryId)
// Internally filters: where('restaurant_id', '==', restaurantId)
```

**❌ WRONG:**
```typescript
const items = await getDocs(collection(db, 'menu_items'))
// This fetches ALL items from ALL restaurants!
```

## Authentication & Authorization

### Auth Context

The `AuthProvider` component provides:
- `user`: Firebase Auth user
- `userData`: User document from Firestore
- `restaurant`: Restaurant document
- `restaurantId`: Current restaurant ID (use this for all queries)
- `loading`: Loading state

### Usage

```typescript
import { useAuth } from '@/components/auth/auth-provider'

function MyComponent() {
  const { restaurantId, restaurant } = useAuth()
  
  // Always use restaurantId for queries
  const items = await getMenuItems(restaurantId)
}
```

## Signup Flow

When a user signs up:

1. **Create Firebase Auth user** - Email/password authentication
2. **Create user document** in `users` collection with:
   - `id`: Firebase Auth UID
   - `email`, `name`, `phone`, `role`: 'owner'
   - `restaurant_id`: Reference to restaurant
3. **Create restaurant document** in `restaurants` collection with:
   - `owner_id`: User's Firebase Auth UID
   - Default settings (currency, timezone, etc.)
4. **Create default categories**: "Starters", "Mains", "Drinks", "Desserts"
5. **DO NOT create menu items** - Restaurant starts with empty menu

## Customer Menu View

### URL Structure
- Format: `/menu/:restaurantId?table=7`
- No authentication required
- Public access

### Data Fetching
```typescript
// Extract restaurantId from URL params
const restaurantId = params.restaurantId

// Fetch ONLY items for this restaurant
const items = await getMenuItems(restaurantId, categoryId)
// Filters: where('restaurant_id', '==', restaurantId)
```

### Empty State
- If no menu items: "Menu coming soon! Please ask staff for assistance."
- No hardcoded demo data

## Restaurant Dashboard

### Authentication Required
- User must be logged in
- Get `restaurantId` from Auth Context

### Menu Management
```typescript
const { restaurantId } = useAuth()
const items = await getMenuItems(restaurantId)
// Only shows items for current restaurant
```

### Live Orders
```typescript
const { restaurantId } = useAuth()
subscribeToOrders(restaurantId, 'new', (orders) => {
  // Only receives orders for current restaurant
})
```

## Firestore Security Rules

Security rules are defined in `firestore.rules`:

- **Users**: Can only read/write their own document
- **Restaurants**: Public read (for customer menus), write by owner only
- **Categories**: Public read, write by restaurant owner
- **Menu Items**: Public read, write by restaurant owner
- **Orders**: Anyone can create (customers), read/update by restaurant owner
- **Tables**: Public read (for QR codes), write by restaurant owner

## Testing Checklist

- [x] Sign up creates user + restaurant + default categories
- [x] Menu Management shows empty state initially
- [x] Adding menu item saves with correct restaurant_id
- [x] Customer menu shows only that restaurant's items
- [x] Live Orders shows only current restaurant's orders
- [x] User A cannot see User B's data
- [x] Firestore security rules prevent unauthorized access
- [x] No hardcoded demo data

## Key Implementation Points

1. **Always use restaurantId from Auth Context** - Never use `user.uid` directly for restaurant data
2. **All queries filter by restaurant_id** - This is enforced in all service functions
3. **Empty states** - Show helpful messages when no data exists
4. **No demo data** - Every user starts with an empty menu
5. **Public customer menus** - No auth required, filtered by restaurant_id from URL

## File Structure

```
lib/firebase/
  ├── types.ts          # Complete database schema
  ├── config.ts         # Firebase initialization
  ├── auth.ts           # Authentication & signup
  ├── restaurants.ts    # Restaurant CRUD
  ├── categories.ts     # Category CRUD (filtered by restaurant_id)
  ├── menu-items.ts     # Menu item CRUD (filtered by restaurant_id)
  ├── orders.ts         # Order CRUD (filtered by restaurant_id)
  └── tables.ts         # Table CRUD (filtered by restaurant_id)

components/
  ├── auth/
  │   └── auth-provider.tsx  # Auth context with restaurant data
  ├── menu-management.tsx     # Uses restaurantId from context
  ├── orders-dashboard.tsx   # Uses restaurantId from context
  └── analytics-dashboard.tsx # Uses restaurantId from context

firestore.rules          # Security rules
firestore.indexes.json   # Required indexes
```

