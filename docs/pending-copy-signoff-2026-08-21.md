# PENDING COPY on production — the sign-off list

> **CLOSED 2026-08-21. All five signed off and deployed.** Production is
> `bbce8cb`; `/api/version` reads it 20/20 on `flashtap.app`, `www.flashtap.app` and
> `riviera.flashtap.app`. Verified at the byte level, not just in source: all 20 JS chunks served
> from `/staff` were fetched and grepped — **zero `PENDING COPY`**, and `Choose a location` is
> present in `b83d276b3729a20a.js`.
>
> | key | shipped wording |
> |---|---|
> | `label` | `Location` |
> | `placeholder` | `Choose a location` |
> | `switching` | `Switching…` (U+2026) |
> | `failedTitle` | `Could not switch location` |
> | `failedBody` | `You are still on your previous location.` |
>
> `waitingForRestaurantElapsed` → `waiting {minutes} min`, signed at the same time, **staging only**;
> it rides with #311. Lowercase was verified at the render site first: it appends to an existing
> sentence inside one `<p>`, so it does not start its own line.
>
> `scripts/check-no-pending-copy.mjs` ran inside the production deploy and passed. The list below is
> kept as the record of what was found and where.

---

## Next batch — not a marker, but queued

**#303's refusal sentence.** `app/api/orders/route.ts` answers 409 for a tab that is not open and
still says *"Your dining session has ended. Please scan the QR code to start a new order."* Under a
409 that is untrue — the tab is being settled, the session has not ended. It is not in
`customer-safe-error.ts`, so the customer sees the generic fallback rather than these words. Left
as-is because vague beats untrue; queued for your next pass.

**This is a genuine limit of the gate:** it catches strings nobody has written yet, not strings that
have stopped being true. Nothing automated will find the next one of these.

---

**Sweep of `origin/main` = `1811b0e`, which is what production serves.** Not the staging gap — the
earlier "tabBackToMenu was the only unsigned copy" was scoped to the main↔staging *gap*, and a
string already live on both branches is not in a gap. That is how this was missed.

**Five placeholder strings are live on production. One is signed. Four need your wording.**
All five are in one file, `components/dashboard/restaurant-switcher.tsx`, in one object.

There are **no others** anywhere in shippable source — `app/`, `components/`, `lib/`, `hooks/`,
`contexts/`, `types/`, `workers/`, `payments/`. A separate scan for `TODO`, `TBD`, `FIXME`,
`PLACEHOLDER`, `LOREM` and `DRAFT COPY` inside string literals returns nothing.

---

## Who sees them

The switcher is mounted by `components/dashboard/dashboard-sidebar.tsx:145`, inside
`app/(staff)/layout.tsx`. So it is on the sidebar of **every one of the twenty staff screens**:

`/analytics` · `/dashboard` · `/dashboard/order-history` · `/documents` · `/menu-management` ·
`/qr-codes` · `/settings` · `/staff` · `/staff/pins` · `/staff/roles` · `/stock` · `/stock/history` ·
`/stock/receive` · `/stock/recipes` · `/stock/recipes/[menuItemId]` · `/stock/transfers` ·
`/stock/transfers/all` · `/stock/transfers/history` · `/stock/transfers/incoming` ·
`/stock/transfers/new`

**Only for multi-restaurant accounts.** `lib/auth/restaurant-switcher-options.ts:67` returns
`visible: options.length > 1`, and the component returns `null` when it is false — a
single-restaurant owner has never seen any of this.

---

## 1. `label` — **SIGNED OFF, done**

| | |
|---|---|
| was | `PENDING COPY — Location` |
| **now** | **`Location`** |
| renders | the `<label>` above the select, `restaurant-switcher.tsx:137` |
| seen on | all twenty screens above, always, whenever the switcher is visible |

This is the one that was read on production. Applied.

---

## The four that need your wording

I have not drafted any of these. The text after the `—` in each placeholder is **the placeholder's
own hint, not proposed copy** — the block's comment says explicitly *"placeholders, not drafted
copy. Do not write final wording here."* So treat the hint as a note about intent and nothing more.

### 2. `placeholder`

| | |
|---|---|
| exact string | `PENDING COPY — Choose a location` |
| key | `SWITCHER_COPY_PENDING.placeholder` |
| renders | `<SelectValue placeholder={…} />`, `restaurant-switcher.tsx:148` |
| **when** | **only while the select has no value** — `value={restaurantId ?? undefined}`. With a restaurant resolved, which is the normal state, this never appears. It shows in the window before the session resolves a restaurant, or if it fails to. |

### 3. `switching`

| | |
|---|---|
| exact string | `PENDING COPY — Switching…` — note that is a real ellipsis character (U+2026), not three dots |
| key | `SWITCHER_COPY_PENDING.switching` |
| renders | a `<p>` under the select, `restaurant-switcher.tsx:159` |
| **when** | while a switch is in flight, on whichever staff screen you were on. Short-lived — the handler does `window.location.assign` on success — but it is on screen for the round trip. |

### 4. `failedTitle`

| | |
|---|---|
| exact string | `PENDING COPY — Could not switch location` |
| key | `SWITCHER_COPY_PENDING.failedTitle` |
| renders | the **title** of a destructive toast, from two call sites: `:108` (the API answered not-ok, or returned no destination) and `:119` (the request threw) |
| **when** | every failed switch, unconditionally. This is the one of the four most likely to be seen. |

### 5. `failedBody`

| | |
|---|---|
| exact string | `PENDING COPY — Your location was not changed. Try again.` |
| key | `SWITCHER_COPY_PENDING.failedBody` |
| renders | the **description** of that same toast, `:109` and `:120` |
| **when** | **only as a fallback.** `:109` is `payload?.error \|\| failedBody` and `:120` is `error instanceof Error ? error.message : failedBody`. So it appears only when the server sent no error message of its own, or when something non-`Error` was thrown. A normal API refusal shows the server's sentence instead. |

---

## Also unsigned, but staging only — not on production

### `waitingForRestaurantElapsed`

| | |
|---|---|
| exact string | `PENDING COPY - waiting {minutes} min` — plain hyphen here, not an em dash |
| key | `QR_REDESIGN_PENDING_COPY.waitingForRestaurantElapsed` |
| renders | the customer's active-order banner, appended after *"Order sent - waiting for the restaurant to confirm"*, while an order request is `waiting_review` and the wait is ≥ 1 minute |
| status | added on `cloudflare-staging` for **#311 B**, ruled today. **Not on production.** |

Worth signing in the same pass, because it now blocks the production deploy the moment #311 is
promoted. `{minutes}` is substituted at the render site.

---

## What happens now

`scripts/check-no-pending-copy.mjs` is wired into `production-worker.yml`'s build verification. **The
next production deploy will fail** while any of these remain — that is the gate doing its job, not a
regression.

Sequence: you sign the four (and optionally the sixth), I replace the strings, the deploy goes
green, and it ships as its own deploy as you asked.

If something urgent must ship before then, `production-worker.yml` has a `skip_verification` input
and the choice is recorded in the run log. It should not be needed.
