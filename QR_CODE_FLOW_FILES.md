# QR Code Scanning Flow - Complete File List

This document lists all files responsible for handling QR code scanning and the features that work after scanning.

---

## 📱 **QR CODE GENERATION & MANAGEMENT**

### 1. **QR Code Creation (Admin Dashboard)**
- **`components/qr-code-management.tsx`**
  - Admin interface for creating QR codes
  - Generates QR codes with URLs: `/menu/{restaurantId}?table={tableNumber}`
  - Manages table creation/deletion

### 2. **URL Building Utilities**
- **`lib/base-url.ts`**
  - `getQRCodeBaseUrl()` - Gets base URL for QR codes
  - `buildMenuUrl()` - Builds menu URL with table parameter

---

## 🚪 **ENTRY POINT (After QR Scan)**

### 3. **Menu Landing Page (First Page After Scan)**
- **`app/menu/[restaurantId]/page.tsx`** ⭐ **CRITICAL**
  - Parses `?table={number}` from QR code URL
  - Loads restaurant data
  - Stores table number in localStorage
  - Displays restaurant info
  - Links to menu browsing

**Key Features:**
- Extracts `table` parameter from URL
- Loads restaurant document from Firestore
- Stores table number for later use
- Shows restaurant header/logo

---

## 🍽️ **MENU BROWSING & ORDERING**

### 4. **Menu Browse Page**
- **`app/menu/[restaurantId]/browse/page.tsx`**
  - Displays menu categories, subcategories, and items
  - Reads `table` parameter from URL
  - Shows active order banner
  - Handles adding items to cart

### 5. **Item Detail Modal**
- **`components/menu/item-detail-modal.tsx`**
  - Shows item details when clicked
  - Handles size/addon selection
  - Adds items to cart

### 6. **Shopping Cart**
- **`app/menu/[restaurantId]/cart/page.tsx`**
  - Displays cart items
  - Reads `table` parameter from URL
  - Calculates totals
  - Links to secure order page

### 7. **Secure Order Page**
- **`app/menu/[restaurantId]/order-secure/page.tsx`** ⭐ **CRITICAL**
  - Final order review
  - Payment method selection
  - **Creates session_id** (if not exists)
  - Submits order to API
  - Reads `table` parameter from URL

**Key Features:**
- Gets/creates session from `lib/session.ts`
- Calls `/api/orders` with `session_id`, `table_number`, `restaurantId`
- Redirects to order confirmation

---

## 📦 **ORDER CREATION**

### 8. **Order Creation API**
- **`app/api/orders/route.ts`** ⭐ **CRITICAL**
  - Receives order POST request
  - Validates `table_number`, `restaurantId`, `items`
  - **Saves `session_id`** to order document
  - Creates order in Firestore
  - Returns `orderId`

**Key Features:**
- Converts `table_number` to Number type
- Explicitly saves `session_id` field
- Uses `ordersPath(restaurantId)` for hierarchical path

---

## ✅ **ORDER CONFIRMATION**

### 9. **Order Confirmation Pages**
- **`app/menu/[restaurantId]/order-confirmation/[orderId]/page.tsx`**
  - Shows order details after creation
  - Reads `table` parameter from URL
  - Displays order number, items, total

- **`app/order-confirmation/page.tsx`**
  - Generic order confirmation page
  - Reads `orderId` from URL

### 10. **Receipt Page**
- **`app/menu/[restaurantId]/receipt/page.tsx`**
  - Displays order receipt
  - Reads `table` parameter from URL

### 11. **My Orders Page**
- **`app/menu/[restaurantId]/my-orders/page.tsx`**
  - Lists customer's orders
  - Reads `table` parameter from URL

---

## 🎯 **ACTIVE ORDER BANNER**

### 12. **Active Order Banner Component**
- **`components/ActiveOrderBanner.tsx`** ⭐ **CRITICAL**
  - Displays banner at top of page
  - Shows order status (new, accepted, preparing, ready)
  - Reads `table` parameter from URL
  - Uses `useActiveOrders` hook

**Key Features:**
- Appears on all menu pages when active order exists
- Clickable - navigates to order confirmation
- Shows order number and status

### 13. **Active Orders Hook**
- **`hooks/useActiveOrders.ts`** ⭐ **CRITICAL**
  - Queries Firestore for active orders
  - Filters by `restaurant_id` + `table_number`
  - Also checks `session_id` (fallback)
  - Returns most recent active order

**Key Features:**
- Queries: `restaurant_id == X AND table_number == Y AND status IN [new, accepted, preparing, ready] AND table_closed == false`
- Uses `getCurrentSession()` to get session_id from localStorage
- Real-time updates via `onSnapshot`

---

## 🔐 **SESSION MANAGEMENT**

### 14. **Client-Side Session**
- **`lib/session.ts`** ⭐ **CRITICAL**
  - `getOrCreateSession()` - Creates unique session ID
  - `getCurrentSession()` - Gets session from localStorage
  - Stores in `localStorage` as `flashtap_session_v1`
  - **Used to tag orders** so banner can find them

**Key Features:**
- Creates UUID session ID on first scan
- Persists across page refreshes
- Unique per device/browser

### 15. **Session Recovery**
- **`lib/session-recovery.ts`**
  - `restoreSessionFromTable()` - Recovers session from table
  - Used for session continuity

### 16. **Table Session Management**
- **`lib/table-session.ts`**
  - `getOrCreateTableSession()` - Creates Firestore table session
  - `getCurrentTableSession()` - Gets session from localStorage
  - Manages table-level sessions in Firestore

---

## 🗄️ **DATA ACCESS LAYER**

### 17. **Restaurant Data**
- **`lib/firebase/restaurants.ts`**
  - `getRestaurant()` - Fetches restaurant document
  - Used by menu landing page

### 18. **Table Data**
- **`lib/firebase/tables.ts`**
  - `getTables()` - Gets all tables for restaurant
  - `getTableByNumber()` - Finds table by number
  - Used for table verification (currently disabled)

### 19. **Menu Data**
- **`lib/firebase/menu-categories.ts`**
  - Fetches menu categories
  - Used by menu browse page
  
- **`lib/firebase/menu-items.ts`**
  - Fetches menu items
  - Used by menu browse page
  
- **`lib/firebase/sub-categories.ts`**
  - Fetches subcategories
  - Used by menu browse page

### 20. **Order Data**
- **`lib/firebase/orders.ts`**
  - `getNextOrderNumber()` - Generates order numbers
  - Order query utilities

---

## 🔒 **SECURITY & CONFIGURATION**

### 21. **Firebase Configuration**
- **`lib/firebase/config.ts`**
  - Initializes Firebase app
  - Exports `db`, `auth`, `storage`
  - Used by all Firestore operations

### 22. **Firestore Security Rules**
- **`firestore.rules`** ⭐ **CRITICAL**
  - Allows **public read** for:
    - `restaurants/{restaurantId}` - Restaurant data
    - `restaurants/{restaurantId}/tables/{tableId}` - Table data
    - `restaurants/{restaurantId}/menu/data/**` - Menu items
  - Allows **public create** for:
    - `restaurants/{restaurantId}/orders/{orderId}` - Order creation
  - Restricts writes to authenticated users

### 23. **Path Utilities**
- **`lib/firebase/paths.ts`**
  - `tablesPath()`, `ordersPath()`, `menuPath()` - Path builders
  - Ensures consistent hierarchical paths

---

## 📊 **DATA FLOW SUMMARY**

```
QR Code Scan
    ↓
URL: /menu/{restaurantId}?table={number}
    ↓
app/menu/[restaurantId]/page.tsx
    ├─ Parses table parameter
    ├─ Loads restaurant (lib/firebase/restaurants.ts)
    └─ Stores table in localStorage
    ↓
app/menu/[restaurantId]/browse/page.tsx
    ├─ Shows menu items (lib/firebase/menu.ts)
    ├─ Shows ActiveOrderBanner (components/ActiveOrderBanner.tsx)
    │   └─ Uses useActiveOrders hook (hooks/useActiveOrders.ts)
    └─ Adds items to cart
    ↓
app/menu/[restaurantId]/cart/page.tsx
    └─ Reviews cart, proceeds to order
    ↓
app/menu/[restaurantId]/order-secure/page.tsx
    ├─ Gets/creates session (lib/session.ts)
    └─ Submits order to API
    ↓
app/api/orders/route.ts
    ├─ Validates order data
    ├─ Saves session_id to order
    └─ Creates order in Firestore
    ↓
app/menu/[restaurantId]/order-confirmation/[orderId]/page.tsx
    └─ Shows order confirmation
    ↓
ActiveOrderBanner appears on all pages
    └─ Queries for active orders by table_number + session_id
```

---

## 🎯 **CRITICAL FILES FOR QR FLOW**

These are the **most important** files for QR code functionality:

1. **`app/menu/[restaurantId]/page.tsx`** - Entry point, parses table parameter
2. **`app/api/orders/route.ts`** - Creates orders with session_id
3. **`components/ActiveOrderBanner.tsx`** - Shows active orders
4. **`hooks/useActiveOrders.ts`** - Queries for active orders
5. **`lib/session.ts`** - Manages session IDs
6. **`firestore.rules`** - Allows public read access

---

## 🔍 **DEBUGGING CHECKLIST**

If QR code flow isn't working, check:

- [ ] `app/menu/[restaurantId]/page.tsx` - Is table parameter parsed correctly?
- [ ] `firestore.rules` - Are tables/menu publicly readable?
- [ ] `app/api/orders/route.ts` - Is session_id saved to order?
- [ ] `hooks/useActiveOrders.ts` - Is query filtering by table_number?
- [ ] `lib/session.ts` - Is session_id created and stored?
- [ ] Browser console - Any permission errors?

---

## 📝 **NOTES**

- **Table verification is currently DISABLED** - menu loads without verifying table exists
- **Session ID** is the key to linking orders to customers across page refreshes
- **All menu pages** read `table` parameter from URL to maintain context
- **Active Order Banner** appears on all pages when active order exists

