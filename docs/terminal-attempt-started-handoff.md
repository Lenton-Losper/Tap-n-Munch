# Terminal Attempt-Started Handoff

## Goal

The web app now distinguishes:

- `paycloud_merchant_order_no allocated`
- `real payment attempt actually started on device`

To make that discriminator work in production, the terminal app must explicitly tell
the web app the moment it launches WiseCashier.

## Endpoint

- Method: `POST`
- Path: `/api/terminal/orders/[orderId]/attempt-started`
- Auth: existing terminal bearer token (`Authorization: Bearer <terminal access token>`)

This is the same terminal JWT/access-token model already used for:

- `/api/terminal/orders/[orderId]/payment`
- `/api/terminal/orders/[orderId]/status`
- `/api/terminal/orders/[orderId]/verify-payment`

The token must decode to `type=terminal` and the terminal must still have
`orders:update`.

## Exact Timing

Fire this request immediately when the device successfully launches WiseCashier for
the order, before any payment outcome is known.

Do not wait for:

- card tap / swipe
- approval / decline
- the terminal payment callback
- `status=cancelled`
- `verify-payment`

This endpoint is specifically the marker for "the real payment flow has started on
device", not "payment succeeded".

## Request Body

Send JSON:

```json
{
  "businessOrderNo": "FT1234567890",
  "appVersion": "terminal-app-version",
  "launchedAt": "2026-07-28T09:08:55.421Z"
}
```

Fields:

- `businessOrderNo`:
  must equal the exact `merchantOrderNo` previously returned by
  `POST /api/terminal/orders/[orderId]/prepare-payment`
- `appVersion`:
  optional but strongly recommended for audit/debugging
- `launchedAt`:
  optional ISO timestamp; if omitted, the server records its current time

## Success Response

Example:

```json
{
  "success": true,
  "recorded": true,
  "startedAt": "2026-07-28T09:08:55.421Z",
  "businessOrderNo": "FT1234567890"
}
```

If the app retries the same request, the endpoint is idempotent and may return
`recorded: false` with the original `startedAt`.

## Failure Cases

- `401`:
  missing/invalid terminal token
- `403`:
  terminal lacks `orders:update` or terminal record is inactive
- `404`:
  order not found for that restaurant
- `400` with `NO_MERCHANT_ORDER_NO`:
  terminal called attempt-started before prepare-payment completed
- `400` with `BUSINESS_ORDER_NO_MISMATCH`:
  terminal sent a `businessOrderNo` that does not match the persisted
  `orders.paycloud_merchant_order_no`

## Required Terminal Flow

1. Call `POST /api/terminal/orders/[orderId]/prepare-payment`
2. Receive `merchantOrderNo` — **or a refusal, see below. Step 1 can now say no.**
3. Launch WiseCashier using that exact value as `businessOrderNo`
4. Immediately call `POST /api/terminal/orders/[orderId]/attempt-started`
5. Continue normal success / failed / status / verify-payment callbacks

## Step 1 Can Refuse (#160)

`prepare-payment` used to allocate unconditionally. It now establishes that the venue can
actually settle a card **before** minting anything, because a reference minted at a venue with
no Finatic credentials can never afterwards be queried, cancelled with confidence, or found in
any portal. Four such references exist on production; two were minted on one evening.

A refusal carries a new `outcome` field. `code`, `error` and the success shape are unchanged,
so a build that does not read `outcome` still behaves as it did — it just gets a non-200.

| HTTP | `outcome` | meaning | what the device should do |
|---|---|---|---|
| 400 | `prepare_card_not_available_here` | this venue has no Finatic merchant/store pair; no card can settle here | **do not launch WiseCashier.** Permanent — retrying achieves nothing. Offer another payment method. |
| 502 | `prepare_readiness_unknown` | we could not establish whether the venue can take a card (the credential read failed) | **do not launch WiseCashier.** Transient — retry is reasonable. |
| 400/404/500 | `prepare_failed` | this order cannot be prepared (already paid, cancelled, not found, allocation failed) | **do not launch WiseCashier.** The order needs looking at. |
| 200 | `null` | `merchantOrderNo` is allocated | continue to step 3 |

A refusal response also carries `merchantOrderNo: null` and `allocated: false`, so "not yet"
and "never" can be told apart.

`staffMessage` carries a human-readable string for builds that do not recognise the `outcome`.
**Those strings are placeholders today** (`PENDING COPY: …`) pending owner-signed copy — see
`lib/payments/prepare-payment-outcome.ts`. A build should prefer branching on `outcome`.

**Launching WiseCashier anyway after a refusal reintroduces the defect**, because the device's
own `businessOrderNo` is then written by the payment callback's stale-APK safety net
(`app/api/terminal/orders/[orderId]/payment/route.ts`) and the order lands in exactly the
unverifiable state this change exists to prevent.

## Why This Matters

When Finatic later returns `E04111`, the web app now treats it as:

- safely cancellable only if no attempt-started marker exists
- still uncertain if attempt-started was recorded

Without this terminal call, every order still looks like "merchant order allocated but
launch may never have started", so the discriminator cannot safely separate abandoned
orders from real in-flight payments.
