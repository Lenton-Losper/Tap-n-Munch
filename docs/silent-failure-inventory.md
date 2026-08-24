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

## WORKED EXAMPLE — the one that reported success for months

Found 2026-08-24 while answering #329. This is the inventory's shape in its purest form, and it is
worth reading before adding an entry above, because it shows how far the illusion can go.

`lib/orders/expire-hosted-pending-orders.ts` cancelled abandoned hosted orders and then closed any
tab left with no active orders. The close was written like this:

```ts
const { error: tabErr } = await supabase
  .from('tabs')
  .update({ status: 'closed', closed_at: nowIso, updated_at: nowIso })
  .eq('id', tabId)

if (tabErr) {
  console.warn('[EXPIRE-HOSTED] Tab close failed:', tabId, tabErr)   // <- the whole failure mode
} else {
  closedTabCount += 1
}
```

**Neither `closed_at` nor `updated_at` exists on `tabs`.** Verified against staging:

```
tabs.closed_at    MISSING (column tabs.closed_at does not exist)
tabs.updated_at   MISSING (column tabs.updated_at does not exist)
the UPDATE shape  REJECTED - Could not find the 'closed_at' column of 'tabs'
```

PostgREST rejects the **entire** patch when one column is unknown, so `status` never changed either.
Every abandoned hosted tab stayed `open` indefinitely, holding `idx_tabs_one_open_per_table` and its
table — which is a contributor to the backlog #333 is about, reached from the opposite direction.

### Why nothing noticed

| layer | why it was silent |
|---|---|
| the function | `console.warn` and carry on; the error was handled, so it was not an error |
| its return value | `closedTabCount` was **always 0**, and 0 is exactly what a healthy run returns when there is nothing to close |
| the cron | `success: true`, because the function did not throw |
| TypeScript | the update payload is an object literal passed to an untyped client; unknown columns are not a type error |
| the tests | none seeded a closeable tab, so none could tell 0-because-nothing-to-do from 0-because-broken |

Five layers, each individually defensible, and the aggregate reported healthy for as long as the
code existed.

### THE RULE

> **A swallowed warn on a write path is a success report that means nothing.**

A `console.warn` in a `catch`, or on an `if (error)` branch that then continues, converts a failed
write into a successful function call. Everything downstream — the return value, the HTTP status,
the cron's log line — is then describing work that did not happen. The log line is not a
consolation: nobody greps `console.warn` on a green pipeline.

Three consequences, all of which this file's other entries also want:

1. **A write path either propagates its failure or counts it.** If it cannot throw — and here it
   genuinely could not, since the orders were already cancelled — the failure count belongs in the
   RETURN VALUE, so it surfaces where the success does. That is why the fixed version returns
   `auditFailureCount`.
2. **A zero must be distinguishable from a nothing.** `closedTabCount: 0` was both "nothing needed
   closing" and "everything failed". Any counter that can mean either is not a signal.
3. **A test asserting `count > 0` proves nothing unless it SEEDS the thing being counted.** The
   negative control is the test — `verify-329-expire-hosted-trail-staging.ts` seeds a closeable tab
   and asserts **the tab row itself** reads `closed`, not that the function said so.

### Where else this exact shape lives

`lib/table-session.ts` patches `session_id` and `updated_at` on `restaurant_tables`, columns that
table does not have, so PostgREST rejects that whole patch too. It carries `@ts-nocheck`, which is
why the compiler never said so. Entry 9 above (`orders.updated_at`, NULL on all 2992 rows) is the
same family: a column that is written or read as if it means something and does not.

**When adding an entry to the inventory, check the write path for this pattern first.** It is
cheaper to find than the absence-shaped failures, because it is a grep: `console.warn` or
`console.error` on a branch that does not return.

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

---

## The audit measured with the instrument it was indicting (#334)

Recorded 2026-08-24. Third instance of one lesson, and the clearest.

#334 was filed to say: *customer wording escapes sign-off because the gate only scans for a MARKER,
and a string that never carried one cannot be found.* It listed **92** such strings, **76** under
`app/menu`.

The real number under `app/menu` is **188**.

The audit scanned **string literals**. Most customer text on those screens is **JSX text**, which
carries no quotes at all:

```jsx
<span className="text-xs text-red-600">Out of stock</span>
<h2 className="text-lg font-bold">Popular Picks</h2>
```

A search for `'...'` cannot see either line. **So the issue reporting that a grep-shaped gate misses
unmarked strings was itself produced by a grep-shaped scan that missed unquoted ones.** It
under-reported by 59% and read as authoritative, because it came with a file-by-file breakdown and
line numbers.

### The same lesson three times now

| | the instrument | what it could not see | how it read |
|---|---|---|---|
| **the E2E** | a positive control on one commit | nothing — it *worked*, and failed 12 times | green pipeline, shipped anyway |
| **the frozen mock** | a double hardcoding the pre-#279 shape | that the server had changed | passing test |
| **#334's audit** | a scan for quoted strings | unquoted JSX text | a precise, credible list |

In all three the instrument answered confidently within its own frame and the frame was wrong. None
of them errored. Two of them produced *numbers*, which is worse than silence: a wrong count invites
you to reason about magnitude.

### THE RULE

> **An audit's finding is bounded by the shape of the thing that found it. State the shape, or the
> count will be read as the truth.**

In practice, before quoting a number from a sweep:

1. **Say what the instrument matches, in the report.** "92 quoted string literals" is honest;
   "92 customer-facing strings" is not, and only one of them survives contact with JSX.
2. **Find one instance by hand and check the tool sees it.** A single `Out of stock` checked
   manually would have exposed this in a minute.
3. **Prefer parsing to matching when the answer is a count.** The replacement gate lexes literals
   and reads JSX text nodes. Its own first version used regexes and reported forty lines of
   TypeScript as customer copy — a regex cannot tell a template literal from two backticks with code
   between them.
4. **Run the instrument in both checkouts.** That same gate excluded `
` from a character class, so
   on CRLF the `` after `>` satisfied it and on LF nothing did: **188 findings on Windows, 135
   from a git checkout of the same tree.** A gate whose answer depends on checkout style is not a
   gate, and it would have been trusted in whichever environment it was first run.

None of this makes #334 a bad issue. It named a real class and the fix went in. The point is
narrower: **the count in an audit is a property of the scan, and it should be reported as one.**
