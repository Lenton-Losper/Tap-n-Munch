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
2. Receive `merchantOrderNo`
3. Launch WiseCashier using that exact value as `businessOrderNo`
4. Immediately call `POST /api/terminal/orders/[orderId]/attempt-started`
5. Continue normal success / failed / status / verify-payment callbacks

## Why This Matters

When Finatic later returns `E04111`, the web app now treats it as:

- safely cancellable only if no attempt-started marker exists
- still uncertain if attempt-started was recorded

Without this terminal call, every order still looks like "merchant order allocated but
launch may never have started", so the discriminator cannot safely separate abandoned
orders from real in-flight payments.
