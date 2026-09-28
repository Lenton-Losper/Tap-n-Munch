# Blocked decisions and deliberate non-changes — 2026-09-13

Written alongside `feat/formal-invoice-from-order`. Everything here is a decision that is **not
mine to take**, or a change I deliberately did not make. Each says what was measured, what the
options are, and what it would cost to be wrong.

Analysis base: `origin/main` `feac9e46`, confirmed as the deployed production commit by sampling
`/api/version`. Production reads were read-only.

---

## 1. Cash-Up reports on `placed_at`, never `paid_at` — BLOCKED BUSINESS DECISION

### Current behaviour, verified on the deployed code

`lib/reports/get-report-data.ts` filters orders by when they were **placed**:

```
:132    .gte('placed_at', startIso)
:133    .lt('placed_at', endIsoExclusive)
:289    .gte('placed_at', startIso)      // the unresolved-orders count
:290    .lt('placed_at', endIsoExclusive)
```

Every takings figure derives from that one query: the terminal cash-up, the PDF, the CSV and the
daily email all call `getReportData`. It reads `orders` and nothing else; gratuities come from
`payment_tips` through a separate report. There is no other date basis anywhere in reporting.

`orders.paid_at` exists and is populated. It is not read by any report.

### Why this cannot be changed quietly

A late payment collected today for an order placed last month would land in **last month's**
takings. That silently changes a figure a manager has already counted, signed off, and possibly
banked. Choosing any answer here is an accounting policy decision, and the three options are not
equivalent:

| | What it does | What it costs |
|---|---|---|
| **A. Report on payment date** | Correct in principle: money counts on the day it arrived | **Moves historical figures.** Every past report changes. Needs a migration-free but reconciliation-heavy rollout, and an agreed cut-over date |
| **B. Keep takings as they are, show late collections separately** | Additive and non-breaking. A "collected today for earlier orders" block outside the method split | Two numbers to reconcile instead of one. Does not fix the underlying ambiguity |
| **C. Restrict pay-later to same-day orders** | Smallest change; the question never arises | May simply not serve the manager's need |

**Nothing was changed.** No safe non-policy improvement exists here: every variant of "make it
better" picks one of the three.

### What is safe today, and is asserted

Formal invoice creation **does not touch Cash-Up at all**. `createInvoiceFromOrder` writes one
`business_documents` row and never writes to `orders`; reporting reads only `orders` and
`payment_tips`. This is enforced by test, not by assertion:

- `invoice-from-order.test.ts` → "the order is byte-identical afterwards"
- `invoice-from-order.test.ts` → "an UNPAID order stays unpaid"
- `invoice-from-order.test.ts` → "no payment, intent, settlement or event row is created"

So an invoice can be raised against any historical order without moving a single reporting figure.
The blocked decision above only becomes urgent when payment **collection** is built.

---

## 2. `POST /api/payments/create` — RETAINED AND UNTOUCHED, deliberately

### What it is

An arbitrary-amount hosted-checkout endpoint. It reads `body.amount`, validates only that it is a
positive number, and creates a real PayCloud checkout session for it. It mints
`orderId = flashtap-pay:<timestamp>`, which is not a FlashTap order id and is written to no table,
so a webhook for it resolves to nothing and the route returns 503 forever.

### Every reference, enumerated

| Reference | Kind |
|---|---|
| `app/flashtap-pay/page.tsx` | UI, not linked from any navigation |
| `app/flashtap-pay/checkout/page.tsx` | UI, reached only from the share URL above |
| `scripts/verify-staging-hardening.ts:57-63` | **security check** asserting the route requires auth |

`createPaymentRequest` — the library beneath it — is a different matter and must stay: it is used by
`app/api/orders/route.ts` and `app/api/order-requests/[requestId]/accept/route.ts` on the real
hosted-checkout path.

### Decision: option C, and no code change in this branch

Removal was preferred and is not taken, for two reasons:

1. **It has a dependent.** `verify-staging-hardening.ts` asserts this route answers 401/403
   unauthenticated. Deleting the route breaks a security script — a small, fixable dependency, but a
   real one, and the standing instruction is to document a dependency rather than break it.
2. **It is a payment surface.** Removing a gateway-facing route deserves its own review and its own
   deploy. Riding it along with an invoice feature is how a gateway behaviour changes by accident.

**The invoice feature does not expose it.** `app/api/admin/documents/from-order/route.ts` imports
nothing from `payments/` and makes no gateway call — asserted by
`invoice-from-order.test.ts` → "the only RPC called is document numbering".

**Recommended follow-up, as its own change:** delete `app/api/payments/create/`,
`app/flashtap-pay/` and the corresponding block in `verify-staging-hardening.ts` together, in one
commit that touches nothing else.

---

## 3. Customer contact storage — NOT IMPLEMENTED, needs a product/privacy decision

`orders` has `customer_name` and no email or phone column. On production `customer_name` is
populated on **8 of 5,377** orders. There is a recorded customer-email purge in this repository's
history (`CUSTOMER_EMAIL_PURGE.md`, `CUSTOMER_EMAIL_FIX_SUMMARY.md`), so the absence looks
deliberate rather than accidental.

**No customer-contact schema was added.** The formal invoice does not need one: `bill_to` is typed by
staff at the moment of issue and snapshotted onto that document, which is what a document is. The
existing send route already derives the recipient from `bill_to.email`
(`lib/documents/business-document-row.ts:105`), so email delivery works with no stored contact
record and no new customer entity.

**The decision that is blocked:** whether FlashTap should retain customer contact details at all, so
that a repeat account customer does not have to be re-typed. That is a privacy and product call, not
an engineering one. Until it is taken, re-typing is the correct behaviour and the UI says so on
screen.

---

## 4. Migration `20260901120000` is still not applied to production — operator action

`restaurant_billing_profiles.vat_registered` does not exist on production. The migration's own header
records that it is `@env: staging` and that applying it to production is a separate, deliberate step.

The billing-profile route no longer depends on it (that was the outage), so **nothing is blocked by
its absence**. But until it is applied:

- Settings → Billing cannot record whether a merchant is VAT registered; the API refuses an explicit
  answer with `VAT_REGISTRATION_UNAVAILABLE` rather than silently dropping it.
- Receipts and invoices continue to show "not answered" for VAT registration, which is true.

**Whether to apply it is the owner's call**, and it is unrelated to this branch. It is additive,
nullable and backfills nothing.

---

## 5. What Namibian tax law requires — NOT ENCODED, and must not be guessed

No Namibian VAT rule is encoded anywhere in this codebase, and none was added. The invoice reuses the
document engine's existing per-line tax hierarchy unchanged.

The required-merchant-details rule I did add is **minimal and evidence-based, not legal**:

- `registration_number` is always required — the renderer prints it, and `20260901120000` measured
  1,241 production receipts stating a VAT amount with no registration number.
- `vat_number` is required **only when the document actually charges VAT**, resolved the way the
  engine resolves it. This mirrors the rule the billing-profile route already enforced.
- **Bank details are not required.** Requiring them would be inventing a rule this codebase does not
  state.

**Needs confirmation from the business/accounting side before these invoices go to customers:**

1. Is a tax invoice legally required for these transactions?
2. What must appear on it, and is the current renderer's content sufficient?
3. Must invoice numbering be gapless across the whole entity, or per outlet? (It is currently per
   restaurant, per document type.)
4. May an order already settled at the table be invoiced afterwards, and does that invoice need to
   show it as already paid? **ANSWERED — Sprint 2026-09-28 brief:** yes, and yes. See below.

### Open question 4 — ANSWERED by the Sprint 2026-09-28 brief

*Superseded text (kept for the record):* an invoice raised from an already-paid order showed
`balance = total`, because `createBusinessDocument` sets `balance = total` for every new document and
`document_payments` had no link to `orders`. It was left as-is pending question 4.

**The ruling (Sprint 2026-09-28 brief):** a paid invoice must show that it is paid; an unpaid or
partially paid invoice must show the total, the amount paid and the amount outstanding.

**What was built** (`lib/documents/create-invoice-from-order.ts`, `lib/documents/invoice-projection.ts`):

- Every figure comes from the financial projection (`lib/orders/order-financials.ts`), never from
  `orders.total` / `orders.items` as stored — both include voided lines.
- At issue, what has ALREADY been collected is written to `document_payments` (one row per
  method + reference; a tab settled by one card payment is one row), and the engine's own
  `recomputeDocumentStatus` then sets `balance` = projection outstanding and `status` = `paid` /
  `partially_paid` / (unpaid) `draft`. The balance is checked against the projection's outstanding
  to the cent; a disagreement voids the document.
- `document_payments` amounts are the projection's per-order paid figures. A `payment_events` row
  contributes only its transaction id and time — never its `amount`, which can cover several orders
  (Riviera N$220 + N$500 = N$720).
- The PDF prints PAID / PARTIALLY PAID / UNPAID, Amount paid, Amount outstanding, the payments
  received (method + masked reference, as receipts print them), and omits "Kindly make payment" when
  nothing is outstanding. The email adds Paid / Outstanding rows for a (partially) paid invoice and
  omits "How to pay" for a fully paid one; **that wording is new and not yet signed** — the signed
  2026-09-05 copy is unchanged for an unpaid invoice.
- The send route also sends an invoice that was issued already paid (`sent_at IS NULL` and status
  `paid`/`partially_paid`); it still refuses anything already sent.

## 6. Tab invoices, cancelled lines and eligibility — Sprint 2026-09-28

- **Tab invoices.** `POST /api/admin/documents/from-order` accepts `tab_id` (exactly one of
  `order_id` / `tab_id`). The invoice covers every order on the tab except settlement artefacts, and
  records `tab_id` and the covered `order_ids` (migration `20260928140000`). "One live invoice per
  order" now means: no live invoice whose `order_id` is the order or whose `order_ids` contains it,
  and one live invoice per tab. `correct_invoice()` carries all three new columns
  (`20260928140100`), so a correction still blocks a duplicate.
- **Cancelled lines** (voided, or on a cancelled order) are stored in `cancelled_line_items`, never in
  `line_items`, and printed under "Cancelled — not charged" with a 0.00 charged column. Keeping them
  out of `line_items` is deliberate: every reader of `line_items` (VAT maths, totals, the credit note
  `correct_invoice` issues) treats a line as charged, and a zero-priced line there reads as "given
  free".
- **Eligibility is "can the total still change?"**, replacing "status is completed". An order is final
  when it is paid, or `completed`, or has a line record for every item and none of them is still
  inside the amend window (every owning station `outstanding`). Refused regardless: awaiting
  re-acceptance, refunded, a card payment in flight or held, overpaid (a refund is owed), a payment
  status that is neither paid nor owing. A round added to the tab after the invoice is a new order it
  does not cover; it can be invoiced on its own.
- **Draft order-linked invoices keep their lines**: the PATCH edit route refuses a change to the line
  items of an invoice with `order_id` or `tab_id` (party, due date and note stay editable).
- **Discounts:** orders carry no discount field, so none is shown. None was invented.
- **Still not encoded:** any Namibian tax rule (section 5 stands).
