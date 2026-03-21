# Environment variables — FlashTap (restaurant-menu-screen)

Set these in **Vercel → Project → Settings → Environment Variables** (and in `.env.local` for local dev).  
Restart / redeploy after changing values.

### Push from local file (CLI)

With the project [linked](https://vercel.com/docs/cli/link) (`vercel link`) and logged in (`vercel login`):

```bash
npm run vercel:env:push
```

This reads `.env.local` (or `.env`) and runs `vercel env add` for **production** and **preview** (secrets use `--sensitive`).  
Flags: `--production-only` or `--with-development` (see `scripts/push-env-to-vercel.mjs`).

---

## Firebase (client — public)

Used by the browser and `lib/firebase/config.ts`. Safe to expose; restrict with **Firestore rules** and **API keys** in Firebase Console.

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Web API key. Firebase Console → Project settings → Your apps → Web app. |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Usually `{projectId}.firebaseapp.com`. |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Project ID. |
| `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` | e.g. `{projectId}.appspot.com`. |
| `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | From Firebase web config. |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | From Firebase web config. |

**Authorized domains:** Add your production domain and `*.vercel.app` under Authentication → Settings → Authorized domains.

---

## Firebase Admin (server only — secret)

Required for **`/api/orders`**, **`/api/webhooks/paycloud`**, and **`/api/payments/receipt`** so Firestore writes succeed on Vercel without using the unauthenticated client SDK.

| Variable | Description |
|----------|-------------|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | **Single-line JSON** string of a Firebase **service account** private key. |
| `FIREBASE_SERVICE_ACCOUNT_B64` | **Optional (recommended on Vercel):** Base64 (UTF-8) of the same JSON — avoids hosts mangling newlines in `private_key`. The app prefers this when set. `npm run vercel:env:push` adds it automatically from your local JSON. |

### How to get `FIREBASE_SERVICE_ACCOUNT_JSON`

1. Open [Firebase Console](https://console.firebase.google.com/) → your project.  
2. **Project settings** (gear) → **Service accounts**.  
3. Click **Generate new private key** → download the JSON file.  
4. **Minify to one line** (remove newlines) or paste as one line in Vercel.  
   - Example (structure only): `{"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",...}`  
5. In Vercel, add variable name `FIREBASE_SERVICE_ACCOUNT_JSON`, value = entire JSON string, scope **Production** (and Preview if needed).

**Security:** Never commit this file or variable to git. Do not prefix with `NEXT_PUBLIC_`.

**IAM:** In Google Cloud Console → IAM, the service account from the JSON usually has **Firebase Admin SDK Administrator Service Agent** / Editor on the Firebase project. If `/api/orders` returns **permission denied**, the key is for the wrong GCP project or Firestore is disabled / blocked for that account.

If this variable is missing, API routes return **503** with:  
`Server configuration error: Firebase Admin not initialized. Add FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_SERVICE_ACCOUNT_B64 to environment variables.`

---

## PayCloud (Finatic) — sandbox / production

| Variable | Description |
|----------|-------------|
| `PAYCLOUD_ENDPOINT` | API base, e.g. sandbox `https://wiseasy-open.sg.wisepaycloud.com/api/entry`. |
| `PAYCLOUD_APP_ID` | App ID from PayCloud merchant portal. |
| `PAYCLOUD_MERCHANT_NO` | Merchant number. |
| `PAYCLOUD_STORE_NO` | Store number. |
| `PAYCLOUD_GATEWAY_PUBLIC_KEY` | Gateway RSA public key (PEM body or base64; app wraps if needed). |
| `PAYCLOUD_PRIVATE_KEY` | Your app RSA private key (PKCS#8), PEM or one-line with `\n`. |
| `PAYCLOUD_WEBHOOK_SECRET` | Optional shared secret if you verify HMAC webhooks. |
| `PAYCLOUD_MERCHANT_CHECKOUT_PATH` | Optional; default `/mcheckout` for merchant-hosted checkout. |
| `PAYCLOUD_QUERY_ORDER_PATH` | Optional; default `/query`. |
| `PAYCLOUD_TIMEOUT_MS` | Optional; default `15000`. |
| `PAYCLOUD_SIGN_TYPE` | Optional; default `RSA2`. |

**Webhook URL (production):**  
`https://<your-domain>/api/webhooks/paycloud`

---

## Code reference

- Admin Firestore: `lib/firebase/admin-firestore.ts` — `adminDb()` returns Firestore or `null`.  
- Firestore security rules: `firestore.rules` — deploy with `firebase deploy --only firestore:rules`.
