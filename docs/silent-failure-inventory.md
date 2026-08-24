# Which customer-facing failures are invisible

Written 2026-08-24, after #279's redaction silently disabled two banners on production and nobody
noticed for two days.

**The question this asks:** when this surface breaks, does it *look* broken? Most of the expensive
defects in this system answer no. A banner that renders nothing, a notification that never fires, a
count that reads zero — each is indistinguishable from a quiet Tuesday.

This is an inventory, not a fix list.

---

## The shape

**Absence looks like normal operation.** Every entry below fails by *not doing something*, and the
system has no way to tell "there was nothing to show" from "I could not find what to show".

The detector is always the same idea: **a positive control** — something that must be present, so
its absence is a failure rather than a silence. The E2E that caught the banner outage is exactly
that, and it is the only one of these that existed in advance.

---

## Inventory

| # | surface | failure looks like | detected by, today |
|---|---|---|---|
| 1 | **ActiveOrderBanner** | no banner — "I have no active order" | ✅ E2E positive control (`banner-shows-only-my-order`) — **caught it** |
| 2 | **OrderStatusBanner** | no notification — "nothing has changed yet" | ❌ **nothing** |
| 3 | **active-table `countOnly`** | `0` — "no orders at this table" | ❌ nothing; feeds banner-clearing and abandoned-checkout detection |
| 4 | **Receipt email** | a receipt row exists, nobody receives mail | ❌ nothing (#234) |
| 5 | **`payment_events` ledger** | rows simply absent | ❌ nothing (#156: 294 card payments have none) |
| 6 | **Webhook signature verification** | `console.warn`, response trusted anyway | ⚠️ permanent and expected (#107) — noise, not signal |
| 7 | **Stale-order cron skip** | order sits pending forever | ✅ now writes `payment.verification_skipped` |
| 8 | **Cron cancel** | order cancelled, no trail | ✅ now writes `order.cancelled` |
| 9 | **`orders.updated_at`** | NULL on all 2992 rows — a dead column read as a change marker | ❌ nothing |
| 10 | **Menu partial outage** | "No items found" — reads as an empty menu | ✅ fixed (#224/#289), banner survives search |
| 11 | **Order confirmation** | "Order not found" for an order that exists | ✅ fixed (#337) + simulator scenario |
| 12 | **Kiosk orders on the till** | staff Decline works on a customer's own order | ❌ nothing (filed as a question) |

---

## The three worth instrumenting first

**2 — OrderStatusBanner.** It called the endpoint with no session scope, so after #279 the client
short-circuited before issuing a request and **no status notification fired for any customer**. It
had no test at any level. Its failure mode is the purest form of this problem: a notification that
does not arrive leaves no trace anywhere, and no customer complains about a message they never knew
was coming.

*What would detect it:* the same shape as the banner E2E — seed an order, change its status, assert
the notification appears. A positive control, not an absence check.

**3 — `countOnly`.** Three call sites on the QR landing depend on it: clearing a stale banner,
detecting abandoned hosted checkouts, and showing the resume-payment prompt. All three degrade to
"do nothing" when the count is wrongly zero, and doing nothing is the normal case.

*What would detect it:* an assertion that a seeded order at a table produces `count >= 1` for its own
session. One line, and it would have caught #279's short-circuit immediately.

**4 — Receipt email.** A receipt row is written and no mail is sent. The customer thinks the receipt
did not arrive; the system thinks it succeeded.

*What would detect it:* nothing short of asserting on the mail provider's response. Currently there
is no customer_email column at all, so the failure is structural rather than accidental.

---

## What made #1 different

The banner outage was caught **on the exact commit that caused it**, by a control written for a
different reason:

```
[control] phone A owns order … and must see "Order #902108" in its banner.
If this fails the negative assertion below proves nothing — fix the fixture, not the guard.
```

That comment is the whole lesson. The author added a positive control so the *negative* assertion
would mean something, and it turned out to be the only instrument in the system that could see a
two-day production outage.

**It then failed twelve times and shipped anyway**, which is why the gate now lives on production
promotion (`docs/` — `staging-health` job). A control nobody is forced to read is a comment.

---

## Companion sweep: mocks frozen on an old contract

Asked at the same time, because it is the same failure one layer down: **a test double that hardcodes
a response shape the server no longer honours passes forever.**

`active-order-banner-renders.test.tsx` mocked the active-table response with `session_id` and no
`isMine` — the pre-#279 contract. It passed green throughout the outage, because it was answering a
question the real server had stopped answering. **Now fixed**, and it enforces the new shape:
removing `isMine` from the fixture fails 3 of 7.

### What the sweep found

Scanned every suite referencing a projected endpoint (`active-table`, `useActiveOrders`,
`tabs/active`) for hardcoded rows carrying fields the projection now drops.

| suite | verdict |
|---|---|
| `active-order-banner-renders` | **was frozen — fixed** |
| `menu-order-status-tracker-multi-round` | not a mock of this endpoint; builds order objects directly |
| `order-status-step-rendering` | same — neither imports `useActiveOrders` or the client |
| `active-table-count-matches-rows` | server-side; the double stands in for Supabase, where those columns are real |
| `guest-orders-accepting-visibility`, `ownership-guards-fail-closed` | server-side / source-scan |
| `tabs-active-count-route`, `tabs-anon-select-omits-members` | assert the `members` redaction itself — the point, not a stale copy |

**One genuinely frozen mock, now repaired.**

### The limit of that answer

The scan is heuristic: it matched suites that name a projected endpoint and carry a dropped field.
**It cannot see a mock that is frozen on a contract nobody has changed yet**, and it would not catch
a double that omits a field the server started sending — which is exactly the `isMine` direction.

The durable fix is not a sweep. It is that a mock of an endpoint should be built from the same
projection the server uses, so the two cannot drift. That is a refactor, not a finding, and it is not
done.
