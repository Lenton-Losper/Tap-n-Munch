# Firebase Integration

## Quick Reference: Where to Find Config Values

In Firebase Console, the config looks like this:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSyB...",           // Copy this
  authDomain: "tapnmunch-fa58f.firebaseapp.com",  // Copy this
  projectId: "tapnmunch-fa58f",  // Copy this
  storageBucket: "tapnmunch-fa58f.appspot.com",   // Copy this
  messagingSenderId: "123456789012",  // Copy this
  appId: "1:123456789012:web:abc..."   // Copy this
};
```

**Location:** Firebase Console → ⚙️ Settings → Project settings → Your apps → Web app config

## Files Created

- `config.ts` - Firebase initialization
- `auth.ts` - Authentication functions (signup, login, logout)

## Usage Example

```typescript
import { signUp, signIn, signOutUser } from '@/lib/firebase/auth'

// Sign up
await signUp('owner@restaurant.com', 'password123', 'Restaurant Name')

// Sign in
await signIn('owner@restaurant.com', 'password123')

// Sign out
await signOutUser()
```

