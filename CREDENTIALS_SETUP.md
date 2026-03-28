# FlashTap PayCloud Credentials Setup

Use this guide when filling credentials for Finatic gateway integration.

## 1) Local files to edit

Fill these in both:
- `.env`
- `.env.local`

Required PayCloud variables:

```bash
PAYCLOUD_ENDPOINT=
PAYCLOUD_APP_ID=
PAYCLOUD_MERCHANT_NO=
PAYCLOUD_STORE_NO=
PAYCLOUD_GATEWAY_PUBLIC_KEY=
PAYCLOUD_PRIVATE_KEY=
PAYCLOUD_WEBHOOK_SECRET=
PAYCLOUD_HOSTED_CHECKOUT_PATH=/checkout
PAYCLOUD_QUERY_ORDER_PATH=/orderquery
PAYCLOUD_QUERY_ORDER_METHOD=query
PAYCLOUD_TIMEOUT_MS=15000
```

## 2) What each value means

- `PAYCLOUD_ENDPOINT`: Base API URL from Finatic/PayCloud (`https://open.finatic.africa/api/entry`).
- `PAYCLOUD_APP_ID`: PayCloud app identifier for your merchant integration.
- `PAYCLOUD_MERCHANT_NO`: Merchant number from your PayCloud account.
- `PAYCLOUD_STORE_NO`: Store number under your merchant.
- `PAYCLOUD_GATEWAY_PUBLIC_KEY`: PayCloud gateway RSA public key (PEM or raw base64).
- `PAYCLOUD_PRIVATE_KEY`: Your merchant private key (PKCS#8 PEM or raw base64).
- `PAYCLOUD_WEBHOOK_SECRET`: Shared secret for HMAC webhook verification (if enabled by your account).
- `PAYCLOUD_HOSTED_CHECKOUT_PATH`: Hosted checkout endpoint path (default `/checkout`).
- `PAYCLOUD_QUERY_ORDER_PATH`: Order query endpoint path (default `/orderquery`).
- `PAYCLOUD_QUERY_ORDER_METHOD`: Order query method name (fixed `query`).
- `PAYCLOUD_TIMEOUT_MS`: Request timeout in milliseconds.

Key formatting notes:
- If key starts with `-----BEGIN`, keep as-is.
- If key is raw base64 only, the app auto-wraps it into PEM:
  - Private: `-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----`
  - Public: `-----BEGIN PUBLIC KEY----- ... -----END PUBLIC KEY-----`

## 3) Vercel checklist (must be set before live deploy)

Set all of the following in `Vercel -> Project -> Settings -> Environment Variables` for both **Production** and **Preview**:

### PayCloud (required)
- [ ] `PAYCLOUD_ENDPOINT`
- [ ] `PAYCLOUD_APP_ID`
- [ ] `PAYCLOUD_MERCHANT_NO`
- [ ] `PAYCLOUD_STORE_NO`
- [ ] `PAYCLOUD_GATEWAY_PUBLIC_KEY`
- [ ] `PAYCLOUD_PRIVATE_KEY`
- [ ] `PAYCLOUD_WEBHOOK_SECRET`
- [ ] `PAYCLOUD_MERCHANT_CHECKOUT_PATH`
- [ ] `PAYCLOUD_QUERY_ORDER_PATH`
- [ ] `PAYCLOUD_TIMEOUT_MS`
- [ ] `DEBUG_PAYCLOUD` (optional; set `true` to force verbose logs in prod)

### Firebase server (required)
- [ ] `FIREBASE_SERVICE_ACCOUNT_JSON` or `FIREBASE_SERVICE_ACCOUNT_B64`

### Firebase client/public (required for app runtime)
- [ ] `NEXT_PUBLIC_FIREBASE_API_KEY`
- [ ] `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- [ ] `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- [ ] `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`
- [ ] `NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID`
- [ ] `NEXT_PUBLIC_FIREBASE_APP_ID`
- [ ] `NEXT_PUBLIC_BASE_URL`

## 4) Run and verify

After filling credentials:
1. Deploy or redeploy.
2. Run local live script:
   - `npm run test:live`
3. For integration smoke test:
   - `npm run test:payment`

Successful live-test signals:
- Step 1 returns reachable endpoint + valid response JSON.
- Step 2 returns a checkout URL or QR payload.
- Step 3 returns order status for your test order ID.
- Step 4 webhook verification returns `{ ok: true, mode: 'rsa' }`.

Failure signals:
- HTTP `401/403`: invalid app/merchant credentials or signature mismatch.
- HTTP `5xx`: PayCloud unavailable or endpoint issues.
- Signature verification failure: wrong gateway key or malformed payload/sign string.
- Timeout/network error: connectivity/DNS/firewall issue.
