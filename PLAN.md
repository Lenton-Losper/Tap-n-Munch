# FlashTap - Authentication & Firebase Integration Plan

## 🎯 Overview
This document outlines the plan for implementing restaurant authentication and Firebase database integration to make the system dynamic and multi-tenant.

---

## 🔐 Authentication Flow

### **Registration/Signup (One-Time)**
Restaurants will register once with:
- **Email** (used as username)
- **Password** (min 8 characters)
- **Restaurant Name** (e.g., "FlashTap")
- **Phone Number**
- **Address** (optional)

### **Login (Session-Based)**
- **Do they login every time?** 
  - **NO** - Use Firebase Auth's persistent sessions
  - Sessions last 30 days (configurable)
  - Auto-logout after inactivity (optional)
  - "Remember me" option for longer sessions

### **Session Management Strategy**
1. **Firebase Auth** handles session persistence automatically
2. **Local storage** for user preferences (not sensitive data)
3. **Protected routes** - redirect to login if not authenticated
4. **Token refresh** - Firebase handles automatically

---

## 🗄️ Firebase Database Structure

### **Firestore Collections**

```
restaurants/
  {restaurantId}/
    - name: "FlashTap"
    - email: "owner@flashtap.com"
    - phone: "+264..."
    - address: "..."
    - createdAt: timestamp
    - settings: {
        currency: "NAD"
        taxRate: 0.15
        serviceCharge: 0.10
      }
    
    menuItems/
      {itemId}/
        - name: "Grilled Salmon"
        - description: "..."
        - category: "Mains"
        - price: 145
        - image: "url or path"
        - status: "available" | "out-of-stock" | "hidden"
        - allowAddons: true
        - allowInstructions: true
        - sizes: [{id, name, price}]
        - addons: [{id, name, price}]
        - createdAt: timestamp
        - updatedAt: timestamp
    
    tables/
      {tableId}/
        - name: "Table 7"
        - location: "Window side"
        - qrCode: "url"
        - isActive: true
        - createdAt: timestamp
    
    orders/
      {orderId}/
        - tableId: "table-7"
        - tableName: "Table 7"
        - status: "new" | "preparing" | "ready" | "done" | "cancelled"
        - items: [
            {
              menuItemId: "..."
              name: "Grilled Salmon"
              quantity: 2
              price: 145
              size: "large"
              addons: ["sauce"]
              specialInstructions: "No onions"
            }
          ]
        - total: 340
        - createdAt: timestamp
        - updatedAt: timestamp
        - completedAt: timestamp (when status = "done")
    
    analytics/
      daily/
        {date}/  // e.g., "2025-11-30"
          - revenue: 12500
          - orders: 45
          - topItems: [...]
          - peakHours: [...]
```

---

## 📊 What Needs to Be Dynamic

### **Currently Hardcoded → Make Dynamic:**

1. **Menu Items** (`components/menu-screen.tsx`)
   - ✅ Fetch from `restaurants/{id}/menuItems`
   - Filter by restaurant ID
   - Real-time updates when menu changes

2. **Orders** (`components/orders-dashboard.tsx`)
   - ✅ Fetch from `restaurants/{id}/orders`
   - Filter by status
   - Real-time updates (new orders appear automatically)

3. **Tables/QR Codes** (`components/qr-code-management.tsx`)
   - ✅ Fetch from `restaurants/{id}/tables`
   - Each table has unique QR code
   - QR code links to: `/menu?restaurant={id}&table={tableId}`

4. **Analytics** (`components/analytics-dashboard.tsx`)
   - ✅ Calculate from orders collection
   - Aggregate by date, item, time
   - Real-time revenue tracking

5. **Restaurant Info**
   - ✅ Restaurant name, logo, settings
   - Display in headers, QR codes, receipts

---

## 🏗️ Implementation Steps

### **Phase 1: Firebase Setup**
1. ✅ Create Firebase project
2. ✅ Enable Authentication (Email/Password)
3. ✅ Create Firestore database
4. ✅ Set up security rules
5. ✅ Install Firebase SDK: `npm install firebase`

### **Phase 2: Authentication**
1. ✅ Create login page (`/login`)
2. ✅ Create signup page (`/signup`)
3. ✅ Create auth context/provider
4. ✅ Protect routes (dashboard, menu-management, etc.)
5. ✅ Add logout functionality

### **Phase 3: Database Integration**
1. ✅ Create Firebase config file
2. ✅ Create service functions for:
   - Menu items (CRUD)
   - Orders (create, read, update status)
   - Tables (CRUD)
   - Analytics (read, aggregate)
3. ✅ Replace hardcoded data with Firebase calls
4. ✅ Add real-time listeners for live updates

### **Phase 4: Multi-Tenant Support**
1. ✅ All queries filter by `restaurantId`
2. ✅ Get `restaurantId` from authenticated user
3. ✅ QR codes include restaurant ID
4. ✅ Menu page reads restaurant from URL params

---

## 🔒 Security Rules (Firestore)

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
        allow read: if request.auth != null;
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

---

## 🎨 User Experience Flow

### **First Time (New Restaurant)**
1. Visit `/signup`
2. Fill registration form
3. Account created → Auto-login
4. Redirected to `/dashboard`
5. Prompted to: "Add your first menu item" or "Set up tables"

### **Returning User**
1. Visit site → Check if logged in
2. If logged in → Go to dashboard
3. If not logged in → Redirect to `/login`
4. After login → Redirect to dashboard

### **Customer Flow (No Auth Required)**
1. Scan QR code → `/menu?restaurant={id}&table={tableId}`
2. Browse menu (fetched from Firebase)
3. Place order → Creates order in Firebase
4. Order appears in restaurant dashboard (real-time)

---

## 📝 Key Decisions

### **1. Session Duration**
- **Recommendation:** 30 days
- Firebase Auth handles this automatically
- Can add "Remember me" for 90 days

### **2. Restaurant ID Strategy**
- **Option A:** Use Firebase Auth UID as restaurant ID
  - ✅ Simple, automatic
  - ✅ One user = one restaurant
  
- **Option B:** Separate restaurant document, link to user
  - ✅ Supports multiple users per restaurant
  - ❌ More complex

**Recommendation:** Start with Option A, upgrade to B later if needed

### **3. Real-Time Updates**
- Use Firestore `onSnapshot()` for:
  - ✅ New orders (dashboard)
  - ✅ Order status changes
  - ✅ Menu updates (if multiple staff editing)

### **4. Image Storage**
- Use **Firebase Storage** for menu item images
- Store URLs in Firestore
- Or use existing `/public` folder for now

---

## 🚀 Next Steps

1. **Set up Firebase project** (you'll need to do this)
2. **Install dependencies:** `npm install firebase`
3. **Create Firebase config file**
4. **Build authentication pages**
5. **Create Firebase service layer**
6. **Replace hardcoded data gradually**

---

## ❓ Questions to Consider

1. **Multiple users per restaurant?** (e.g., manager + staff)
   - If yes → Need user roles/permissions
   - If no → Keep it simple with one user = one restaurant

2. **Customer accounts?** 
   - For now: No (guests can order)
   - Future: Maybe for order history, loyalty points

3. **Payment integration?**
   - Current: Simulated
   - Future: Stripe, PayPal, mobile money?

4. **Notifications?**
   - Real-time order alerts?
   - Email/SMS notifications?

---

## 📦 File Structure (After Implementation)

```
lib/
  firebase/
    config.ts          # Firebase initialization
    auth.ts            # Auth functions
    menu.ts            # Menu CRUD operations
    orders.ts          # Order operations
    tables.ts          # Table management
    analytics.ts        # Analytics queries

app/
  login/
    page.tsx
  signup/
    page.tsx
  dashboard/
    page.tsx           # Protected route

components/
  auth/
    auth-provider.tsx  # Auth context
    protected-route.tsx
```

---

Ready to start implementing? Let me know which phase you'd like to tackle first! 🚀

