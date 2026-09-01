# Real-card test procedure

**The only step left that software cannot do.** Everything upstream and downstream of the card
itself is covered by `__tests__/payment-lifecycle-scenarios.test.ts` (19 scenarios: success,
duplicate callbacks, ten concurrent callbacks, settling twice, retries, decline, cancellation,
false-failure correction, wrong amount, missing amount, unreachable gateway, and refusing to
receipt money that has not arrived). None of that touches a card, a gateway or production.

This is what you do with a real card, and what to check afterwards.

---

## Where to do it, and why

**Chownow Nedbank.** It is the only venue that is fully ready and has **never recorded a single
sale event** — the venue whose live NAD 17 card payment failed on 2026-09-01 for missing
credentials, since fixed along with the stale Redis entry and the missing cache invalidation
(`35a7fe9a`, deployed). A tap there proves something no other venue can.

Confirm readiness first — read-only, no charge:

```bash
node scripts/prod/verify-card-payment-readiness.mjs
```

Expect `Chownow Nedbank  PASS`, credentials present, at least one live till, and the webhook
answering 200. **If it does not say PASS, stop** — the failure is a configuration problem, not
something to discover mid-transaction.

## Before you start

1. Use a **real card you control** and a **small amount** (NAD 5–20). This is a live charge.
2. Note the time. You will need it to find the rows.
3. Have the venue's terminal in hand and know which till it is (`terminal_name` from the probe).
4. Decide in advance whether you will refund. **A refund does not restore stock** (ruled
   2026-09-01) — if the item is inventory-tracked, its ingredients stay deducted, and correcting
   that is a deliberate stock adjustment, not something the refund does for you.

## The run

| # | Do | Expect on the P5 |
|---|---|---|
| 1 | Open a table, add one item, send the round | The line appears, "Being made" |
| 2 | Kitchen (or bar) bumps it ready | Chip turns "Ready" |
| 3 | Tap **Take payment**, choose card | Reader prompts for the card |
| 4 | **Tap or insert the real card** | Reader approves |
| 5 | Wait for the terminal to return | Screen shows the payment succeeded |
| 6 | Check the table view | "Paid in full · table still open" |
| 7 | Print or view the receipt | Correct total, VAT line, masked reference |

If the reader **declines**, that is a valid test too — the order must remain unpaid, not cancelled
until the gateway is asked, and no receipt may exist. Record it and carry on.

## Afterwards — verify from the database, not the screen

The screen showing "paid" is the claim; the rows are the effect.

```bash
node scripts/prod/verify-card-payment-readiness.mjs      # a sale event now exists for the venue
```

Then confirm, read-only, that all five landed for **your** order:

| What | Where | Expect |
|---|---|---|
| Order settled | `orders` | `payment_status = 'paid'`, `status = 'completed'`, `paid_at` set |
| Reference kept | `orders.payment_reference` | the gateway's reference, non-null |
| Sale recorded | `payment_events` | one `sale` row for this venue at this time |
| Audit trail | `audit_logs` | one `payment.completed`, with `amountMeaning` |
| Receipt | `receipt_documents` | exactly ONE row, `RCT-######`, snapshot total equal to what you paid |

**One receipt, not two.** If there are two, the idempotency guard has regressed and that is a
stop-everything finding.

## What to check on the receipt itself

- Total matches the amount actually charged.
- The masked reference ends in the last four of the gateway reference.
- **VAT**: if the venue has answered the registration question, the number appears. If it has not
  — and today **none of the five trading venues has** — the receipt correctly carries no VAT
  number, and `outlet.vat_registered` is null meaning *unknown*, not *unregistered*. That is the
  honest state, not a defect to fix on the spot.

## If something goes wrong

| Symptom | What it means | Do |
|---|---|---|
| Reader approves, app says failed | The false-failure path. The system asks Finatic and corrects to paid **only if the amounts match exactly**. | Check `audit_logs` for `payment.verification_uncertain`. Do not re-charge. |
| App shows pending and stays there | Gateway unreachable. Deliberately undecided — it will not guess. | Leave it. The reconcile cron or a human resolves it. **Do not tap again.** |
| Charged but no receipt | Issuance failed after settlement; the payment stands. | Re-issue: the endpoint is idempotent and returns the same document. |
| Two receipts | Idempotency regression. | Stop. Report. |

**Never re-tap a card to "make it work".** The uncertain state exists precisely so that a real
charge is not duplicated, and tapping again is the one action that defeats it.

## What this does not prove

- That Finatic posts the webhook back for a real transaction — only a real transaction shows that.
- That the Redis credential cache agrees with the database; that needs the app runtime, and the
  readiness probe says so rather than implying it was checked.
- Anything about the other four venues. They are configured, but only the venue you test is tested.
