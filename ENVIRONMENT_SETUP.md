# Environment variables — FlashTap (restaurant-menu-screen)

Set these in **Vercel → Project → Settings → Environment Variables** (and in `.env.local` for local dev).  
Restart / redeploy after changing values.

For a complete per-variable paste guide and live-test checklist, see `CREDENTIALS_SETUP.md`.

### Push from local file (CLI)

With the project [linked](https://vercel.com/docs/cli/link) (`vercel link`) and logged in (`vercel login`):

```bash
npm run vercel:env:push
```

This reads `.env.local` (or `.env`) and runs `vercel env add` for **production** and **preview** (secrets use `--sensitive`).  
Flags: `--production-only` or `--with-development` (see `scripts/push-env-to-vercel.mjs`).

---

## Supabase (auth, database, storage)

**Staff authentication is handled by Supabase Auth** (email/password). Customer menu flows use Supabase for orders and data; they do not require staff login.

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (Dashboard → Project Settings → API). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key — safe for the browser with RLS enabled. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server only (secret).** Used by API routes and server-side Supabase clients. Never expose as `NEXT_PUBLIC_*`. |
| `SUPABASE_STORAGE_BUCKET` | Optional; defaults to `menu-images` for menu/logo uploads. |

**Auth redirect URLs:** In Supabase Dashboard → Authentication → URL Configuration, add your production domain, preview URLs (`*.vercel.app`), and `http://localhost:3000` for local dev. Password reset emails use the redirect URL passed from the app (typically `/signin`).

---

## PayCloud (Finatic) — production gateway

| Variable | Description |
|----------|-------------|
| `PAYCLOUD_ENDPOINT` | API base, fixed to `https://open.finatic.africa/api/entry`. |
| `PAYCLOUD_APP_ID` | App ID from PayCloud merchant portal. |
| `PAYCLOUD_MERCHANT_NO` | Merchant number. |
| `PAYCLOUD_STORE_NO` | Store number. |
| `PAYCLOUD_GATEWAY_PUBLIC_KEY` | Gateway RSA public key (PEM body or base64; app wraps if needed). |
| `PAYCLOUD_PRIVATE_KEY` | Your app RSA private key (PKCS#8), PEM or one-line with `\n`. |
| `PAYCLOUD_WEBHOOK_SECRET` | Optional shared secret if you verify HMAC webhooks. |
| `PAYCLOUD_HOSTED_CHECKOUT_PATH` | Optional; default `/checkout`. |
| `PAYCLOUD_QUERY_ORDER_PATH` | Optional; default `/orderquery`. |
| `PAYCLOUD_TIMEOUT_MS` | Optional; default `15000`. |
| `PAYCLOUD_SIGN_TYPE` | Optional; default `RSA2`. |

**Webhook URL (production):**  
`https://<your-domain>/api/webhooks/paycloud`

---

## Code reference

- Browser Supabase client: `lib/supabase/client.ts`
- Server Supabase client: `lib/supabase/server.ts`
- Staff auth helpers: `lib/supabase/auth.ts`
- Auth context: `components/auth/auth-provider.tsx`
