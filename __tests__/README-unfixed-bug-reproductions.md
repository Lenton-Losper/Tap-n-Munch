# Reproductions for UNFIXED bugs

These five suites reproduce money bugs that are **real and unfixed on `main`** as of
`74356aa` (2026-07-30). They are kept on this branch, not on `main`, because they assert
**current buggy behaviour** — so they pass today and are expected to **fail** once each bug
is fixed. That flip is the point: when you fix one, its suite going red is your proof.

Run with `node node_modules/jest/bin/jest.js __tests__/qa-hunt-<name>` — note
`node_modules/.bin/` is empty in this environment, so `npx jest` will not work.

Every suite includes a CONTROL case proving the harness is not manufacturing the result.

---

### `qa-hunt-reconcile-marks-cancelled-paid`
`app/api/payments/reconcile/route.ts`. Writes `payment_status:'paid'` filtered on `.eq('id', …)`
only — no payment-status predicate. `loadOrders` fetches purely by id, and the `:83`
short-circuit uses strict `===`, so a **cancelled** order falls through and is marked paid with
`cancellation_reason`/`cancelled_at` left intact.

Worse than a status bug: `expectedAmount` at `:86` **sums cancelled orders' totals**, so the
Finatic amount check passes against an inflated figure and both orders are marked paid. A real
N$100 order plus a cancelled N$400 produces `expectedAmount = 500`. **Customer overcharge.**

### `qa-hunt-document-payment-overpay-race`
`app/api/admin/documents/[id]/payments/route.ts`. Read balance → validate → **unconditional**
insert, with no predicate on the balance just validated, no idempotency key, and no transaction.
Two concurrent N$100 payments on a N$100 invoice both return 201: N$200 banked, balance −100.

**Unrecoverable.** `document_payments` is append-only — only constraint is `amount > 0`, no
trigger, and the sole route exports `GET`/`POST` only. The surplus row can never be removed.

Cannot be fixed in TypeScript: a `BEFORE INSERT` trigger doing `SELECT SUM(...)` under READ
COMMITTED does **not** prevent the race. Needs a plpgsql RPC — `record_terminal_refund_event()`
(migration `20260727120000`) is a working in-repo template.

### `qa-hunt-quote-convert-double-invoice-race`
`app/api/admin/documents/[id]/convert/route.ts`. The invoice is created **before** the status
write, so adding `.eq('status', …)` to the UPDATE would not help — the duplicate document
already exists. Two concurrent converts produce two invoices with distinct sequence numbers,
both pointing at the same quote. **Customer billed twice.**

### `qa-hunt-recompute-status-lost-update`
`lib/documents/recompute-status.ts`. Itself an unguarded read-then-write. 40 + 60 fully settle a
N$100 invoice, but the stored column is left at 60 and status drops back to `partially_paid`.

This **constrains any fix** to the over-payment race above: the payments route gates on the
stored `balance`, so a fix that keeps trusting that column inherits a second, independent
over-payment path. The guard must recompute from `document_payments` inside the lock.

### `qa-hunt-analytics-vs-report-revenue`
`lib/supabase/analytics.ts:33,90` vs `lib/reports/get-report-data.ts:86,133`. Dashboard revenue
and the emailed report disagree on the same orders: a cancelled-but-paid order is revenue on one
and absent from the other, and a fully refunded order counts 100% on the dashboard and 0 in the
report (refunds write `payment_events` only and never change `orders.payment_status`).

---

## Not included here

Reproductions that became fixes live with their PRs: the Close Table sweep (#112) and the
merchant-order rotation (#113). The F-1 settle suite lives with #114.

The original Close Table repro is preserved at
`scratchpad/EVIDENCE-qa-hunt-table-close-paid-sweep.test.ts`. **Do not cite it as evidence for
#112** — its mock implements no `.select`, so on that branch every case dies at the first read
and its CONTROL passes vacuously. It documented the bug on `main` and nothing more.
