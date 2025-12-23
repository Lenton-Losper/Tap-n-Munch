# Order Schema Redesign - Complete Implementation

## 🎯 Goal
Eliminate undefined Firestore fields permanently by implementing a clean, explicit customer-info-based order flow.

## ✅ Changes Implemented

### 1️⃣ Frontend (Checkout Page)
**File:** `app/menu/[restaurantId]/checkout/page.tsx`

**Changes:**
- ✅ Customer name and phone are now **REQUIRED** (not optional)
- ✅ Form validation prevents submission without both fields
- ✅ "Place Order" button is disabled until both fields are filled
- ✅ Visual indicators (red asterisks) show required fields
- ✅ Error messages guide users to fill required fields

**New Payload Structure:**
```typescript
{
  restaurantId: string,
  tableNumber: number,
  customer: {
    name: string,    // REQUIRED
    phone: string    // REQUIRED
  },
  items: OrderItem[],
  subtotal: number,
  tax: number,
  total: number,
  paymentMethod: 'cash' | 'card',
  notes?: string
}
```

### 2️⃣ API Contract
**File:** `app/api/orders/route.ts`

**New API Contract:**
```typescript
POST /api/orders
{
  restaurantId: string,
  tableNumber: number,
  customer: {
    name: string,    // REQUIRED - validated
    phone: string   // REQUIRED - validated
  },
  items: OrderItem[],
  total: number
}
```

**Validation:**
- ✅ Rejects if `customer.name` is missing or empty
- ✅ Rejects if `customer.phone` is missing or empty
- ✅ Rejects if legacy fields (`customer_email`, `customer_name`, `customer_phone`) exist at root level
- ✅ Returns clear error messages for validation failures

### 3️⃣ Firestore Order Schema
**New Schema:**
```typescript
{
  restaurant_id: string,
  order_number: number,
  table_number: number,
  customer: {
    name: string,
    phone: string
  },
  items: OrderItem[],
  subtotal: number,
  tax: number,
  service_fee: number,
  discount: number,
  tip: number,
  total: number,
  status: 'new',
  payment_status: 'pending',
  payment_method: 'cash' | 'card' | 'mobile_money',
  order_instructions: string | null,
  placed_at: ISO string,
  created_at: ISO string,
  updated_at: ISO string
}
```

**Key Points:**
- ✅ No `customer_email`, `customer_name`, or `customer_phone` at root level
- ✅ Customer info is nested in `customer` object
- ✅ All fields explicitly defined (no spread operators)
- ✅ Status hard-coded to `'new'`
- ✅ Payment status hard-coded to `'pending'`

### 4️⃣ Sanitization
**Before `addDoc()`:**
1. ✅ Recursively removes all `undefined` values
2. ✅ Validates no forbidden keys exist:
   - `customer_email`
   - `customer_name`
   - `customer_phone`
   - `customerEmail`
   - `customerName`
   - `customerPhone`
3. ✅ Throws error if forbidden fields found
4. ✅ Throws error if undefined values found
5. ✅ Logs final payload in development mode

### 5️⃣ Legacy Code Removal
**Files Updated:**
- ✅ `lib/firebase/types.ts` - Updated `Order` interface to use nested `customer` object
- ✅ `lib/firebase/orders.ts` - Removed `nuclearClean` function, updated `Order` interface
- ✅ `components/orders-dashboard.tsx` - Updated to read from `order.customer.name` and `order.customer.phone`
- ✅ `lib/firebase/analytics.ts` - Updated to read from `order.customer?.phone`

**Removed:**
- ❌ All `customer_email` references
- ❌ All `customer_name` references (replaced with `customer.name`)
- ❌ All `customer_phone` references (replaced with `customer.phone`)
- ❌ Legacy `nuclearClean` function

### 6️⃣ TypeScript Types
**File:** `lib/firebase/types.ts`

**Before:**
```typescript
customer_name: string | null
customer_phone: string | null
customer_email: string | null
```

**After:**
```typescript
customer: {
  name: string
  phone: string
}
```

### 7️⃣ Logging
**Development Mode:**
- ✅ Logs final Firestore payload before write
- ✅ Format: Pretty-printed JSON for easy debugging

**Production Mode:**
- ✅ No logging (performance optimization)

## 🔄 Data Flow

### Before (Problematic)
```
Frontend → Optional fields → API → Legacy fields → Firestore ❌ undefined errors
```

### After (Fixed)
```
Frontend → Required customer object → API → Validation → Strict constructor → Firestore ✅
```

## 🛡️ Protection Layers

1. **Frontend Validation**: Required fields prevent empty submissions
2. **API Validation**: Server-side validation ensures required fields exist
3. **Forbidden Field Rejection**: API rejects legacy fields at root level
4. **Strict Constructor**: Explicitly builds order object (no spread operators)
5. **Recursive Sanitization**: Removes undefined values from entire object tree
6. **Final Validation**: Checks for forbidden fields and undefined values before write

## 📋 Testing Checklist

After deployment:
- [ ] Customer name and phone are required on checkout page
- [ ] "Place Order" button is disabled until both fields are filled
- [ ] Order creation succeeds with valid customer info
- [ ] Order creation fails with missing customer name
- [ ] Order creation fails with missing customer phone
- [ ] Order appears in Firestore with `customer` object (not flat fields)
- [ ] Order appears in restaurant dashboard
- [ ] No `customer_email`, `customer_name`, or `customer_phone` in Firestore document
- [ ] No undefined value errors in console

## 🚀 Deployment Steps

1. **Commit Changes:**
   ```bash
   git add .
   git commit -m "Redesign: New customer object schema, required customer info"
   git push
   ```

2. **Wait for Vercel Deployment** (2-5 minutes)

3. **Clear Browser Cache:**
   - Hard refresh: `Ctrl + Shift + R`
   - Or use incognito window

4. **Test Order Creation:**
   - Fill in customer name and phone (required)
   - Place order
   - Verify in Firestore console

## ⚠️ Breaking Changes

**For Existing Orders:**
- Old orders may have `customer_name` and `customer_phone` at root level
- Dashboard code handles both old and new schemas (backward compatible)
- New orders will always use the new `customer` object schema

**For API Consumers:**
- API now requires `customer` object (not flat fields)
- Legacy fields at root level will be rejected
- Customer name and phone are now required (not optional)

## 📝 Notes

- The strict constructor pattern ensures no undefined values reach Firestore
- All customer info is now required, improving data quality
- Nested `customer` object provides better structure for future extensions
- Backward compatibility maintained in dashboard for existing orders

