# Complete Database Schema & Architecture Documentation

## Overview

This document provides a comprehensive description of the Tap n Munch restaurant QR ordering platform database architecture. The system uses **Firebase Firestore** (NoSQL document database) as the primary data store, with **Firebase Storage** for file uploads (images).

---

## Database System: Firebase Firestore

### Characteristics
- **Type**: NoSQL Document Database
- **Structure**: Collections → Documents → Fields
- **Real-time**: Supports real-time listeners via `onSnapshot()`
- **Queries**: Indexed queries with composite indexes
- **Security**: Rule-based access control at collection/document level
- **Scalability**: Automatic scaling, multi-region support

### Key Design Principles
1. **Multi-tenancy**: All data is isolated by `restaurant_id`
2. **Denormalization**: Some data is duplicated for query performance
3. **Real-time Updates**: Critical data (orders, menu) uses real-time listeners
4. **Security First**: All collections have security rules enforcing data isolation

---

## Collections Overview

The database consists of **9 main collections**:

1. `users` - User accounts and authentication
2. `restaurants` - Restaurant profiles and settings
3. `menu_categories` - Top-level menu categories (NEW)
4. `sub_categories` - Second-level menu categories (NEW)
5. `menu_items` - Individual menu items
6. `tables` - Table/QR code management
7. `table_sessions` - Active table sessions for order tracking
8. `orders` - Customer orders
9. `analytics_daily` - Daily aggregated analytics

**Legacy Collection** (deprecated but still exists):
- `categories` - Old single-level category system (being phased out)

---

## Collection Schemas (Detailed)

### 1. `users` Collection

**Purpose**: Store user account information linked to Firebase Authentication.

**Document ID**: Firebase Auth UID (same as `id` field)

**Schema**:
```typescript
{
  id: string                    // Firebase Auth UID (same as document ID)
  email: string                 // User email address
  name: string                  // User's full name
  phone: string                 // User's phone number
  role: 'owner' | 'manager' | 'staff'
  restaurant_id?: string         // FK to restaurants.id (optional for staff)
  created_at: string            // ISO 8601 timestamp
  last_login: string            // ISO 8601 timestamp
}
```

**Relationships**:
- `restaurant_id` → `restaurants.id` (one-to-one, optional)
- Document ID = Firebase Auth UID

**Security Rules**:
- Read: User can only read their own document (`request.auth.uid == userId`)
- Write: User can only create/update their own document
- Delete: Prevented (soft delete pattern)

**Indexes**: None required (queries by document ID only)

**Usage Patterns**:
- Created during signup
- Updated on login (`last_login`)
- Used for authentication context

---

### 2. `restaurants` Collection

**Purpose**: Store restaurant profile, settings, and configuration.

**Document ID**: Auto-generated Firestore ID

**Schema**:
```typescript
{
  id: string                    // Auto-generated document ID
  owner_id: string              // FK to users.id (Firebase Auth UID)
  owner_uid: string             // Firebase Auth UID (for Storage rules)
  name: string                  // Restaurant name
  slug: string                  // URL-friendly: "tap-n-munch"
  description: string           // Restaurant description
  email: string                 // Restaurant contact email
  phone: string                 // Restaurant phone number
  address: string               // Physical address
  logo_url: string | null       // Firebase Storage URL for logo
  primary_color: string         // Brand color: "#FF6B35"
  currency: string              // Currency code: "NAD"
  timezone: string              // IANA timezone: "Africa/Windhoek"
  online_ordering_enabled: boolean
  payment_methods: string[]     // ["cash", "card", "mobile_money"]
  tax_rate: number              // 0.15 for 15% VAT
  service_fee: number           // Service fee amount
  subscription_tier: 'starter' | 'professional' | 'enterprise'
  subscription_status: 'active' | 'inactive' | 'trial'
  created_at: string            // ISO 8601 timestamp
  updated_at: string            // ISO 8601 timestamp
}
```

**Relationships**:
- `owner_id` → `users.id` (many-to-one)
- Referenced by: `menu_categories`, `sub_categories`, `menu_items`, `tables`, `orders`, `analytics_daily`

**Security Rules**:
- Read: Public (for customer menus)
- Create: Authenticated users only
- Update: Restaurant owner only (`isRestaurantOwner()`)
- Delete: Prevented

**Indexes**: None required (queries by document ID or owner_id)

**Usage Patterns**:
- Created during signup (one per user)
- Updated via Settings page
- Publicly readable for customer menu display
- Used for branding (logo, colors) on QR landing pages

**Design Notes**:
- `owner_id` and `owner_uid` are duplicates (both store Firebase Auth UID)
- `owner_uid` exists specifically for Firebase Storage rules (simpler lookup)
- `slug` is URL-friendly version of name (for future custom domains)

---

### 3. `menu_categories` Collection

**Purpose**: Top-level menu organization (e.g., "Drinks", "Food", "Specials").

**Document ID**: Auto-generated Firestore ID

**Schema**:
```typescript
{
  id: string                    // Auto-generated document ID
  restaurant_id: string         // FK to restaurants.id
  name: string                  // "Drinks", "Food", "Specials"
  description: string | null    // Optional category description
  display_order: number         // For sorting (0, 1, 2, ...)
  active: boolean               // Show/hide category
  created_at: string            // ISO 8601 timestamp
  updated_at: string            // ISO 8601 timestamp
}
```

**Relationships**:
- `restaurant_id` → `restaurants.id` (many-to-one)
- Referenced by: `sub_categories` (one-to-many)

**Security Rules**:
- Read: Public (for customer menus)
- Create: Authenticated users only
- Update/Delete: Restaurant owner only

**Indexes**:
```json
{
  "fields": [
    { "fieldPath": "restaurant_id", "order": "ASCENDING" },
    { "fieldPath": "active", "order": "ASCENDING" },
    { "fieldPath": "display_order", "order": "ASCENDING" }
  ]
}
```

**Usage Patterns**:
- Queried by: `restaurant_id` + `active = true`, ordered by `display_order`
- Created during restaurant initialization (default categories)
- Updated via Menu Management UI

**Design Notes**:
- Part of 3-level menu hierarchy: `menu_categories` → `sub_categories` → `menu_items`
- `display_order` allows custom sorting
- `active` flag for soft-delete pattern

---

### 4. `sub_categories` Collection

**Purpose**: Second-level menu organization (e.g., "Alcoholic drinks", "Soft drinks" under "Drinks").

**Document ID**: Auto-generated Firestore ID

**Schema**:
```typescript
{
  id: string                    // Auto-generated document ID
  restaurant_id: string         // FK to restaurants.id
  menu_category_id: string      // FK to menu_categories.id
  name: string                  // "Alcoholic drinks", "Soft drinks"
  description: string | null    // Optional description
  display_order: number         // For sorting within parent category
  active: boolean               // Show/hide sub-category
  created_at: string            // ISO 8601 timestamp
  updated_at: string            // ISO 8601 timestamp
}
```

**Relationships**:
- `restaurant_id` → `restaurants.id` (many-to-one)
- `menu_category_id` → `menu_categories.id` (many-to-one)
- Referenced by: `menu_items` (one-to-many)

**Security Rules**:
- Read: Public (for customer menus)
- Create: Authenticated users only
- Update/Delete: Restaurant owner only

**Indexes**:
```json
{
  "fields": [
    { "fieldPath": "restaurant_id", "order": "ASCENDING" },
    { "fieldPath": "menu_category_id", "order": "ASCENDING" },
    { "fieldPath": "active", "order": "ASCENDING" },
    { "fieldPath": "display_order", "order": "ASCENDING" }
  ]
}
```

**Usage Patterns**:
- Queried by: `restaurant_id` + `menu_category_id` + `active = true`, ordered by `display_order`
- Created via Menu Management UI
- Used to group menu items

**Design Notes**:
- Middle level of 3-level hierarchy
- Must belong to a `menu_category`
- `restaurant_id` is denormalized for query performance (avoids joins)

---

### 5. `menu_items` Collection

**Purpose**: Individual menu items (dishes, drinks, etc.).

**Document ID**: Auto-generated Firestore ID

**Schema**:
```typescript
{
  id: string                    // Auto-generated document ID
  restaurant_id: string         // FK to restaurants.id (denormalized)
  menu_category_id: string      // FK to menu_categories.id (denormalized)
  sub_category_id: string       // FK to sub_categories.id (primary parent)
  category_id?: string          // Legacy field (deprecated)
  
  name: string                  // Item name
  description: string           // Item description
  image_url: string | null      // Firebase Storage URL
  base_price: number            // Base price in restaurant currency
  
  // Image display options
  imageFit?: 'contain' | 'cover' | 'fill' | 'scale-down'
  imagePosition?: 'center' | 'top' | 'bottom'
  
  // Customizations
  has_sizes: boolean            // Can customer select size?
  sizes: MenuItemSize[]         // [{ name: "Small", price_modifier: -20 }, ...]
  has_addons: boolean           // Can customer add extras?
  addons: MenuItemAddon[]       // [{ name: "Extra Sauce", price: 15 }, ...]
  allow_special_instructions: boolean
  
  // Availability
  status: 'available' | 'out_of_stock' | 'hidden'
  
  // Analytics (denormalized for performance)
  times_ordered: number         // Count of times ordered
  total_revenue: number         // Total revenue from this item
  
  created_at: string            // ISO 8601 timestamp
  updated_at: string            // ISO 8601 timestamp
}
```

**Nested Types**:
```typescript
MenuItemSize {
  name: string                  // "Small", "Regular", "Large"
  price_modifier: number        // -20, 0, +25 (price adjustment)
}

MenuItemAddon {
  name: string                  // "Extra Sauce"
  price: number                 // Additional cost
}
```

**Relationships**:
- `restaurant_id` → `restaurants.id` (many-to-one)
- `menu_category_id` → `menu_categories.id` (many-to-one, denormalized)
- `sub_category_id` → `sub_categories.id` (many-to-one, primary parent)
- Referenced by: `orders.items[].menu_item_id` (one-to-many)

**Security Rules**:
- Read: Public (for customer menus)
- Create: Authenticated users + must validate `sub_category_id` exists and belongs to same restaurant
- Update/Delete: Restaurant owner only

**Indexes**:
```json
// Multiple indexes for different query patterns:

// 1. By restaurant + sub_category + name
{
  "fields": [
    { "fieldPath": "restaurant_id", "order": "ASCENDING" },
    { "fieldPath": "sub_category_id", "order": "ASCENDING" },
    { "fieldPath": "name", "order": "ASCENDING" }
  ]
}

// 2. By restaurant + menu_category + status + sub_category + name
{
  "fields": [
    { "fieldPath": "restaurant_id", "order": "ASCENDING" },
    { "fieldPath": "menu_category_id", "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "sub_category_id", "order": "ASCENDING" },
    { "fieldPath": "name", "order": "ASCENDING" }
  ]
}

// 3. By restaurant + status + name (legacy)
{
  "fields": [
    { "fieldPath": "restaurant_id", "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "name", "order": "ASCENDING" }
  ]
}
```

**Usage Patterns**:
- Queried by: `restaurant_id` + `sub_category_id` + `status = 'available'`
- Queried by: `restaurant_id` + `menu_category_id` + `status = 'available'` (for category view)
- Updated via Menu Management UI
- Analytics fields updated when orders are placed

**Design Notes**:
- Heavy denormalization: `restaurant_id` and `menu_category_id` stored on every item
- `category_id` is legacy field (being phased out)
- `times_ordered` and `total_revenue` are denormalized analytics (updated on order completion)
- Images stored in Firebase Storage, URLs stored here

---

### 6. `tables` Collection

**Purpose**: Manage physical tables and their QR codes.

**Document ID**: Auto-generated Firestore ID

**Schema**:
```typescript
{
  id: string                    // Auto-generated document ID
  restaurant_id: string         // FK to restaurants.id
  table_number: number          // Numeric table identifier (1, 2, 3, ...)
  table_name: string            // Display name: "Table 7" or "Patio Table 3"
  location: string | null       // "Main Dining Area", "Patio", etc.
  qr_code_url: string           // Full menu URL: "https://app.com/menu/rest_id?table=7"
  qr_code_image: string         // Firebase Storage URL for QR code image
  active: boolean               // Is table active?
  created_at: string            // ISO 8601 timestamp
}
```

**Relationships**:
- `restaurant_id` → `restaurants.id` (many-to-one)
- Referenced by: `orders.table_id` (one-to-many, optional)
- Referenced by: `table_sessions.table_number` (one-to-many, by number)

**Security Rules**:
- Read: Public (for QR code scanning)
- Create: Authenticated users only
- Update/Delete: Restaurant owner only

**Indexes**:
```json
{
  "fields": [
    { "fieldPath": "restaurant_id", "order": "ASCENDING" },
    { "fieldPath": "active", "order": "ASCENDING" },
    { "fieldPath": "table_number", "order": "ASCENDING" }
  ]
}
```

**Usage Patterns**:
- Queried by: `restaurant_id` + `active = true`, ordered by `table_number`
- Created via QR Code Management UI
- QR code images generated and stored in Firebase Storage
- Used to generate customer menu URLs with table number

**Design Notes**:
- `table_number` is the primary identifier (not document ID)
- QR codes encode: `/menu/{restaurantId}?table={table_number}`
- `active` flag allows soft-delete

---

### 7. `table_sessions` Collection

**Purpose**: Track active table sessions for order persistence across browser sessions.

**Document ID**: Auto-generated Firestore ID

**Schema**:
```typescript
{
  id: string                    // Auto-generated document ID
  restaurant_id: string         // FK to restaurants.id
  table_number: number          // Table number (not FK, just number)
  status: 'active' | 'closed'   // Session state
  created_at: Timestamp         // Firestore server timestamp
  closed_at?: Timestamp         // When session was closed
}
```

**Relationships**:
- `restaurant_id` → `restaurants.id` (many-to-one)
- Referenced by: `orders` (via `table_number`, not direct FK)

**Security Rules**:
- Read: Public (for session validation)
- Create: Anyone (customers create sessions)
- Update: Authenticated users (staff can close tables)
- Delete: Prevented

**Indexes**:
```json
{
  "fields": [
    { "fieldPath": "restaurant_id", "order": "ASCENDING" },
    { "fieldPath": "table_number", "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" }
  ]
}
```

**Usage Patterns**:
- Queried by: `restaurant_id` + `table_number` + `status = 'active'` (find active session)
- Created when customer scans QR code
- Updated to `closed` when staff closes table
- Used to persist orders across browser sessions

**Design Notes**:
- **Critical for order persistence**: Orders are linked to tables, not browser sessions
- Only ONE active session per table at a time
- When table is closed, all orders for that table are marked `table_closed = true`
- Prevents order leakage to new customers at same table

---

### 8. `orders` Collection

**Purpose**: Store customer orders with full details.

**Document ID**: Auto-generated Firestore ID

**Schema**:
```typescript
{
  id: string                    // Auto-generated document ID
  order_number: number           // Sequential per restaurant (1, 2, 3, ...)
  restaurant_id: string          // FK to restaurants.id
  table_id: string | null        // FK to tables.id (optional)
  table_number: number           // Table number (denormalized for queries)
  
  // Customer info (nested object - NEW SCHEMA)
  customer: {
    name: string                 // Customer name
    phone: string                // Customer phone
  }
  
  // Order items (array of nested objects)
  items: OrderItem[]             // See OrderItem schema below
  
  order_instructions: string | null  // Special instructions
  
  // Pricing breakdown
  subtotal: number               // Sum of item prices
  tax: number                    // Calculated tax
  service_fee: number            // Service fee
  discount: number               // Discount amount
  tip: number                    // Tip amount
  total: number                  // Final total
  
  // Payment
  payment_method: 'cash' | 'card' | 'mobile_money'
  payment_status: 'pending' | 'paid' | 'failed'
  paid_at: string | null         // ISO 8601 timestamp
  
  // Order lifecycle
  status: 'new' | 'accepted' | 'preparing' | 'ready' | 'completed' | 'cancelled'
  table_closed: boolean          // Is table closed? (prevents order leakage)
  
  // Timestamps (lifecycle tracking)
  placed_at: Timestamp           // When order was placed (REQUIRED)
  accepted_at: string | null     // ISO 8601 timestamp
  preparing_at: string | null
  ready_at: string | null
  completed_at: string | null
  cancelled_at: string | null
  
  // Analytics
  prep_time_minutes: number | null  // Time from accepted to ready
  
  // Metadata
  created_at: Timestamp          // Firestore server timestamp
  updated_at: Timestamp          // Firestore server timestamp
  session_id?: string             // Optional: browser session ID (deprecated for banner)
  source: 'qr_menu'              // Order source
}
```

**Nested Type: OrderItem**:
```typescript
OrderItem {
  menu_item_id: string           // FK to menu_items.id
  name: string                   // Item name (denormalized)
  quantity: number               // Quantity ordered
  base_price: number             // Base price at time of order
  selected_size: {                // Selected size (if applicable)
    name: string
    price_modifier: number
  } | null
  selected_addons: Array<{        // Selected addons
    name: string
    price: number
  }>
  special_instructions: string   // Customer special instructions
  subtotal: number               // Line item total
}
```

**Relationships**:
- `restaurant_id` → `restaurants.id` (many-to-one)
- `table_id` → `tables.id` (many-to-one, optional)
- `items[].menu_item_id` → `menu_items.id` (many-to-many via array)
- Linked to `table_sessions` via `table_number` (not direct FK)

**Security Rules**:
- Create: Anyone (customers can place orders)
- Read: Restaurant owner only
- Update: Restaurant owner OR authenticated user (for status updates)
- Delete: Prevented

**Indexes**:
```json
// Multiple indexes for different query patterns:

// 1. Active orders by restaurant + table + status + table_closed + placed_at
{
  "fields": [
    { "fieldPath": "restaurant_id", "order": "ASCENDING" },
    { "fieldPath": "table_number", "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "table_closed", "order": "ASCENDING" },
    { "fieldPath": "placed_at", "order": "DESCENDING" }
  ]
}

// 2. Orders by restaurant + status + placed_at (dashboard)
{
  "fields": [
    { "fieldPath": "restaurant_id", "order": "ASCENDING" },
    { "fieldPath": "status", "order": "ASCENDING" },
    { "fieldPath": "placed_at", "order": "DESCENDING" }
  ]
}

// 3. Orders by session_id + placed_at (legacy, for backward compatibility)
{
  "fields": [
    { "fieldPath": "session_id", "order": "ASCENDING" },
    { "fieldPath": "placed_at", "order": "DESCENDING" }
  ]
}
```

**Usage Patterns**:
- **Active Orders Query**: `restaurant_id` + `table_number` + `status IN ['new', 'accepted', 'preparing', 'ready']` + `table_closed = false`
- **Dashboard Query**: `restaurant_id` + `status = 'new'`, ordered by `placed_at DESC`
- Created via Order API route (server-side)
- Updated via Orders Dashboard (status changes)
- Real-time listeners for live order updates

**Design Notes**:
- **Critical**: `table_number` is used for banner queries (not `session_id`)
- `table_closed` flag prevents order leakage to new customers
- `customer` is nested object (not flat fields) - prevents security issues
- `placed_at` is REQUIRED for all queries (must be set on creation)
- `order_number` is sequential per restaurant (not globally unique)
- Items are fully denormalized (name, price stored) for historical accuracy
- `session_id` is optional and deprecated for banner logic

---

### 9. `analytics_daily` Collection

**Purpose**: Store daily aggregated analytics for restaurants.

**Document ID**: Format: `"analytics_{date}_{restaurantId}"` (e.g., `"analytics_2025-01-25_rest_abc123"`)

**Schema**:
```typescript
{
  id: string                    // "analytics_2025-01-25_rest_abc123"
  restaurant_id: string          // FK to restaurants.id
  date: string                   // "2025-01-25" (YYYY-MM-DD)
  
  // Aggregated metrics
  total_orders: number           // Count of orders
  total_revenue: number          // Sum of order totals
  total_tax: number              // Sum of tax
  total_tips: number              // Sum of tips
  new_customers: number          // Count of unique new customers
  returning_customers: number    // Count of returning customers
  avg_order_value: number        // Average order total
  avg_prep_time_minutes: number  // Average prep time
  
  // Top items (array)
  top_items: Array<{
    item_id: string              // FK to menu_items.id
    name: string                 // Item name (denormalized)
    orders: number               // Count of times ordered
    revenue: number              // Revenue from this item
  }>
  
  // Peak hours (array)
  peak_hours: Array<{
    hour: number                 // 0-23 (hour of day)
    orders: number               // Count of orders in this hour
  }>
  
  // Payment breakdown (optional)
  payment_breakdown?: {
    cash_orders: number
    card_orders: number
    cash_revenue: number
    card_revenue: number
  }
}
```

**Relationships**:
- `restaurant_id` → `restaurants.id` (many-to-one)
- `top_items[].item_id` → `menu_items.id` (many-to-many via array)

**Security Rules**:
- Read: Restaurant owner only
- Create/Update: Authenticated users (typically server-side)
- Delete: Prevented

**Indexes**: None required (queries by document ID or `restaurant_id` + `date`)

**Usage Patterns**:
- Created/updated daily via batch job or on order completion
- Queried by: `restaurant_id` + date range
- Used for analytics dashboard

**Design Notes**:
- Pre-aggregated data for performance (avoids real-time calculations)
- Document ID includes date for easy querying
- Nested arrays for top items and peak hours
- Optional `payment_breakdown` for future features

---

## Relationships Diagram

```
users (1) ──< (1) restaurants (1) ──< (N) menu_categories
                                              │
                                              │ (1)
                                              │
                                              ▼
                                         sub_categories (1) ──< (N) menu_items
                                                                     │
                                                                     │ (referenced by)
                                                                     │
restaurants (1) ──< (N) tables ──< (N) table_sessions              │
                                                                     │
restaurants (1) ──< (N) orders ──> (N) menu_items (via items[])    │
                                                                     │
restaurants (1) ──< (N) analytics_daily ──> (N) menu_items (via top_items[])
```

**Key Relationships**:
- **One-to-Many**: Restaurant → Menu Categories, Sub Categories, Menu Items, Tables, Orders, Analytics
- **Many-to-One**: All collections → Restaurant (except users)
- **Many-to-Many**: Orders ↔ Menu Items (via `items[]` array)
- **One-to-One**: User ↔ Restaurant (via `restaurant_id`)

---

## Data Isolation & Multi-Tenancy

### Critical Rule: All Queries MUST Filter by `restaurant_id`

Every query that fetches data must include a filter on `restaurant_id` to ensure users only see their own data.

**✅ CORRECT**:
```typescript
const items = await getMenuItems(restaurantId, categoryId)
// Internally: where('restaurant_id', '==', restaurantId)
```

**❌ WRONG**:
```typescript
const items = await getDocs(collection(db, 'menu_items'))
// This fetches ALL items from ALL restaurants!
```

### Isolation Strategy

1. **Application Level**: All service functions require `restaurantId` parameter
2. **Security Rules**: Firestore rules enforce ownership checks
3. **Auth Context**: `useAuth()` hook provides `restaurantId` for all queries
4. **Denormalization**: `restaurant_id` stored on every document for efficient filtering

---

## Indexes

Firestore requires composite indexes for queries with multiple `where()` clauses or `orderBy()`.

### Index Strategy

1. **Query Pattern Analysis**: Indexes created based on actual query patterns
2. **Composite Indexes**: Multiple fields combined for complex queries
3. **Order Matters**: Field order in index must match query order
4. **Automatic Creation**: Firestore suggests indexes when queries fail

### Key Indexes

1. **Orders - Active Orders Banner**:
   - `restaurant_id` + `table_number` + `status` + `table_closed` + `placed_at DESC`
   - Used for: Customer banner showing active orders

2. **Orders - Dashboard**:
   - `restaurant_id` + `status` + `placed_at DESC`
   - Used for: Staff dashboard showing orders by status

3. **Menu Items - Category View**:
   - `restaurant_id` + `menu_category_id` + `status` + `sub_category_id` + `name`
   - Used for: Customer menu browsing

4. **Sub Categories - Menu Organization**:
   - `restaurant_id` + `menu_category_id` + `active` + `display_order`
   - Used for: Menu category/sub-category hierarchy

---

## Security Rules Architecture

### Rule Structure

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Helper functions
    function isRestaurantOwner(restaurantId) { ... }
    
    // Collection rules
    match /collection/{documentId} {
      allow read: if condition;
      allow create: if condition;
      allow update: if condition;
      allow delete: if condition;
    }
  }
}
```

### Security Principles

1. **Default Deny**: All access denied unless explicitly allowed
2. **Owner-Based**: Most writes require restaurant ownership
3. **Public Reads**: Customer-facing data (menus, restaurants) is publicly readable
4. **Customer Writes**: Orders can be created by anyone (customers)
5. **No Deletes**: Soft-delete pattern using `active` flags

### Collection-Specific Rules

| Collection | Read | Create | Update | Delete |
|------------|------|--------|--------|--------|
| `users` | Own document only | Own document only | Own document only | Prevented |
| `restaurants` | Public | Authenticated | Owner only | Prevented |
| `menu_categories` | Public | Authenticated | Owner only | Owner only |
| `sub_categories` | Public | Authenticated | Owner only | Owner only |
| `menu_items` | Public | Authenticated + validation | Owner only | Owner only |
| `tables` | Public | Authenticated | Owner only | Owner only |
| `table_sessions` | Public | Anyone | Authenticated | Prevented |
| `orders` | Owner only | Anyone | Owner/Authenticated | Prevented |
| `analytics_daily` | Owner only | Authenticated | Authenticated | Prevented |

---

## Data Flow Patterns

### 1. Order Creation Flow

```
Customer scans QR
  ↓
Table session created/resumed (table_sessions)
  ↓
Customer adds items to cart (client-side)
  ↓
Customer submits order
  ↓
POST /api/orders (server-side)
  ↓
Validate: restaurant_id, table_number, items
  ↓
Get next order_number (Firestore transaction)
  ↓
Create order document (orders collection)
  ↓
Return order ID to client
  ↓
Real-time listener updates dashboard
```

### 2. Menu Display Flow

```
Customer visits /menu/{restaurantId}?table=7
  ↓
Fetch restaurant (restaurants collection)
  ↓
Fetch menu_categories (filtered by restaurant_id)
  ↓
Fetch sub_categories (filtered by restaurant_id + menu_category_id)
  ↓
Fetch menu_items (filtered by restaurant_id + sub_category_id)
  ↓
Display menu with hierarchy
```

### 3. Order Status Update Flow

```
Staff updates order status (Orders Dashboard)
  ↓
Update order document (orders collection)
  ↓
Set status-specific timestamp (accepted_at, preparing_at, etc.)
  ↓
Real-time listener updates customer banner
  ↓
If status = 'ready': Calculate prep_time_minutes
```

### 4. Table Close Flow

```
Staff clicks "Close Table"
  ↓
Find active table_sessions (filtered by restaurant_id + table_number)
  ↓
Update sessions: status = 'closed', closed_at = now
  ↓
Find orders for table (filtered by restaurant_id + table_number + table_closed = false)
  ↓
Update orders: table_closed = true, status = 'completed'
  ↓
Customer banner disappears (real-time listener)
```

---

## Design Patterns & Decisions

### 1. Denormalization Strategy

**Why**: Firestore doesn't support joins. Denormalization improves query performance.

**Examples**:
- `restaurant_id` stored on every menu-related document
- `menu_category_id` stored on `menu_items` (even though it's accessible via `sub_category_id`)
- Customer name/phone stored in `orders.customer` (not referenced)
- Item name/price stored in `orders.items[]` (for historical accuracy)

**Trade-offs**:
- ✅ Faster queries (no joins needed)
- ✅ Better for real-time listeners
- ❌ More storage space
- ❌ Must update multiple documents when data changes

### 2. Soft Delete Pattern

**Why**: Preserve data integrity and enable analytics.

**Implementation**:
- `active: boolean` flag on categories, sub-categories, menu items, tables
- `status: 'closed'` on table_sessions
- `table_closed: boolean` on orders
- No hard deletes (security rules prevent deletion)

**Benefits**:
- Historical data preserved
- Can restore "deleted" items
- Analytics remain accurate

### 3. Sequential Order Numbers

**Why**: Human-readable order numbers per restaurant.

**Implementation**:
- `order_number` is sequential per restaurant (1, 2, 3, ...)
- Generated via Firestore transaction to ensure uniqueness
- Stored in `orders` collection

**Alternative Considered**: UUIDs (rejected - not user-friendly)

### 4. Table-Based Order Tracking

**Why**: Orders belong to tables, not browser sessions.

**Implementation**:
- Orders linked via `table_number` (not `session_id`)
- `table_sessions` track active sessions
- When table closes, orders marked `table_closed = true`
- Banner queries use `table_number` + `table_closed = false`

**Benefits**:
- Orders persist across browser sessions
- New customers don't see previous orders
- Staff can close tables to reset state

### 5. Nested Customer Object

**Why**: Security and data integrity.

**Implementation**:
- `customer: { name, phone }` nested object in orders
- NOT flat fields (`customer_name`, `customer_phone`)
- Prevents security issues with field injection

**History**: Previously used flat fields, migrated to nested object for security.

### 6. Real-Time Listeners

**Why**: Live updates without polling.

**Usage**:
- Orders Dashboard: Real-time order status updates
- Customer Banner: Real-time order status for active orders
- Menu Display: Real-time restaurant logo/name updates

**Implementation**:
- `onSnapshot()` for Firestore collections
- Automatic reconnection on network issues
- Cleanup on component unmount

---

## Firebase Storage Architecture

### Storage Structure

```
firebase-storage/
  ├── restaurants/
  │   └── {restaurantId}/
  │       └── logo.png                    # Restaurant logo
  ├── menu-items/
  │   └── {restaurantId}/
  │       └── {itemId}-{timestamp}.{ext}  # Menu item images
```

### Storage Rules

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // Restaurant logos
    match /restaurants/{restaurantId}/logo.png {
      allow read: if true;  // Public read
      allow write: if request.auth != null
        && isRestaurantOwner(restaurantId)
        && request.resource.size < 2MB
        && request.resource.contentType.matches('image/(jpeg|jpg|png|webp)');
    }
    
    // Menu item images
    match /menu-items/{restaurantId}/{fileName} {
      allow read: if true;  // Public read
      allow write: if request.auth != null
        && request.resource.size < 5MB
        && request.resource.contentType.matches('image/.*');
    }
  }
}
```

### File Naming Conventions

- **Logos**: Fixed name `logo.png` (replaces existing on upload)
- **Menu Items**: `{itemId}-{timestamp}.{ext}` (unique per upload)
- **QR Codes**: Generated client-side, stored in `tables.qr_code_image`

---

## Query Patterns Reference

### Common Queries

1. **Get Active Orders for Table**:
```typescript
query(
  collection(db, 'orders'),
  where('restaurant_id', '==', restaurantId),
  where('table_number', '==', tableNumber),
  where('status', 'in', ['new', 'accepted', 'preparing', 'ready']),
  where('table_closed', '==', false),
  orderBy('placed_at', 'desc')
)
```

2. **Get Menu Items by Category**:
```typescript
query(
  collection(db, 'menu_items'),
  where('restaurant_id', '==', restaurantId),
  where('sub_category_id', '==', subCategoryId),
  where('status', '==', 'available'),
  orderBy('name', 'asc')
)
```

3. **Get Orders by Status**:
```typescript
query(
  collection(db, 'orders'),
  where('restaurant_id', '==', restaurantId),
  where('status', '==', 'new'),
  orderBy('placed_at', 'desc')
)
```

4. **Get Active Table Session**:
```typescript
query(
  collection(db, 'table_sessions'),
  where('restaurant_id', '==', restaurantId),
  where('table_number', '==', tableNumber),
  where('status', '==', 'active'),
  limit(1)
)
```

---

## Migration & Evolution

### Legacy Collections

- **`categories`**: Old single-level category system
  - Status: Deprecated
  - Migration: Restaurants using new 3-level hierarchy
  - Backward Compatibility: `menu_items.category_id` still exists

### Schema Evolution

1. **Customer Data**: Migrated from flat fields to nested object
2. **Order Tracking**: Migrated from `session_id` to `table_number` + `table_closed`
3. **Menu Hierarchy**: Migrated from single-level to 3-level hierarchy
4. **Storage Rules**: Added `owner_uid` for simpler ownership checks

### Future Considerations

- Custom domains (not implemented, but `slug` field prepared)
- Multi-location restaurants (would require `location_id` field)
- Staff management (would require `users.role` expansion)
- Inventory tracking (would require new `inventory` collection)

---

## Performance Considerations

### Query Optimization

1. **Indexes**: All composite queries have indexes
2. **Denormalization**: Reduces need for multiple queries
3. **Pagination**: Large result sets use `limit()` and cursors
4. **Real-Time**: Selective listeners (only active data)

### Storage Optimization

1. **Image Compression**: Images compressed before upload
2. **Lazy Loading**: Menu images loaded on demand
3. **CDN**: Firebase Storage serves via CDN

### Scalability

1. **Horizontal Scaling**: Firestore scales automatically
2. **Regional Deployment**: Can deploy to multiple regions
3. **Caching**: Client-side caching for frequently accessed data

---

## Conclusion

This database architecture is designed for:
- **Multi-tenancy**: Complete data isolation per restaurant
- **Real-time Updates**: Live order tracking and menu updates
- **Scalability**: Handles growth without architectural changes
- **Security**: Rule-based access control at every level
- **Performance**: Optimized queries with proper indexing
- **Maintainability**: Clear relationships and patterns

The system balances denormalization for performance with data integrity through validation and security rules.

