# Brief for the terminal repo — two changes, both client-side

The server halves are done and on `cloudflare-staging`. **Neither of these can be done from the web
repo**: the POS/terminal client is a separate React Native APK and its source is not on this machine
(`C:\RN` holds SDK artefacts only). This is what to hand to that repo.

---

## 1. Stop treating `success: true` as "the payment resolved"

### What changed on the server

`POST /api/terminal/orders/:id/payment` and `PATCH /api/terminal/orders/:id/status` both used to
answer **`success: true`** for `outcome: 'left_pending_finatic_uncertain'` — the same value they
return for a confirmed payment and for a confirmed cancel.

**They now answer `success: false` for that outcome.** The field is still present on every response;
only its value changed.

| outcome | `success` | meaning | what the operator must be told |
|---|---|---|---|
| `corrected_to_paid` | `true` | the reader reported a failure, but Finatic confirmed the money was taken | **Paid.** Release the order. |
| `cancelled` | `true` | definitively not taken | **Not paid, resolved.** Do not release. |
| `left_pending_finatic_uncertain` | **`false`** | the gateway could not confirm either way; the order is still `pending` | **Unknown. Do not release the food.** |

`outcome` is the precise discriminator and `reason` carries the detail. **Branch on `outcome`, not
on `success`** — `success` now merely stops contradicting it, and a future outcome added
server-side would otherwise fall silently into whichever branch `success` picked.

### What to check and change in the terminal

1. **Does the payment handler branch on `success` or on `outcome`?** If on `success`, an unconfirmed
   payment previously rendered identically to a confirmed one. That is the #868 mechanism.
2. **Is there a branch for `left_pending_finatic_uncertain` at all**, or does it fall through to a
   generic success/failure screen?
3. **The screen for that outcome must say the food is not to be released.** `canClose: false` is the
   only other discriminating field the API sends today, and "do not close the table" is not the same
   instruction as "do not hand over this order".

### One interaction to be aware of

A terminal that now shows an *error* where it used to show success may prompt the operator to retry
the payment. **Until change 2 below ships, every retry creates a brand-new order** — so this fix can
increase the number of stranded rows while making the operator better informed. That is the right
trade (a wrong success released food; a retry costs a row), but it is an argument for doing both
changes together.

### Filed as #327, with the audit trail from #868.

---

## 2. Send `x-idempotency-key`

### The server already implements this and has for a long time

- `app/api/terminal/orders/route.ts:140` reads `request.headers.get('x-idempotency-key')`.
- `lib/orders/create-order.ts:115` writes it, and `:123` treats a `23505` unique violation as
  *"this order already exists"* and returns the existing row instead of creating a duplicate.

**Measured on production, all time: 0 of 1545 POS orders carry a key.** Nothing is sending the
header. The customer app already sends it — `app/menu/[restaurantId]/cart/page.tsx:299` and `:386`,
`app/menu/[restaurantId]/order-secure/page.tsx:113` — so this is one client not honouring a contract
its sibling already does.

### What to change

Generate a key per **sale attempt**, and send it as `x-idempotency-key` on order creation:

- **Stable across retries of the same sale.** Generate it when the operator starts ringing up, hold
  it while that sale is on screen, and reuse it on every retry of that sale.
- **New for a genuinely new sale.** Clear it when the sale completes, is abandoned, or the operator
  starts a new one.
- Any collision-resistant string is fine; the server only compares equality.

**No server change is needed.** The retry-safety already works the moment the header arrives.

### Why it matters

A failed payment launch leaves the order at `payment_status = 'pending'`. Staff retry. With no key,
the retry creates a new order and the first is stranded — and because it carries a
`paycloud_merchant_order_no`, the stale-order cron sends it to the Finatic branch, answers E04111,
and skips it forever. So each retry permanently adds a row.

Confirmed duplicate-retry pairs at Mingle: **#85 → #86** (30s apart, identical Americano) and
**#101 → #102** (74s apart, identical item).

### Filed as #328.

---

## 3. Not now, but the change that removes the ambiguity at source

Recorded here so it travels with the other two. **The SALE path does not report an operator cancel
unambiguously; the REFUND path already does**, with a distinct `status: 'CANCELLED', retryable:
false`.

Because SALE does not, an operator abort — where nothing was ever sent to the gateway, so E04111 is
the correct and expected answer — is indistinguishable from a launch whose fate is genuinely unknown.
Both look identical to the server: `attempt_started` present, reference allocated, gateway silent.

Four explicit outcomes would fix it: `CANCELLED_PRE_GATEWAY` (WiseCashier `K026`),
`DECLINED_BY_GATEWAY`, `COMPLETED`, `UNKNOWN`. The point is that **`UNKNOWN` becomes rare and
explicit** instead of the silent default for every launch that does not report. Most abandoned sales
would then resolve in two minutes with no gateway call at all.

Full reasoning in `docs/design-persistence-pass-2026-08-21.md`, Part 3. **Not ruled for build yet.**
