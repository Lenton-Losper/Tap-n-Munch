# Five rulings, answerable in one pass

The five issues from `overnight-issue-log.md` that are blocked on a decision only you can make.
Each is one sentence, the options, and my recommendation. **Nothing is implemented, and nothing
will be until you answer.**

---

## #319 — The terminal app and the web app share one git remote

**Decision:** do we split the React Native terminal into its own repository, or accept the shared
remote and write it down so it stops surprising people?

- **A. Record it.** A note in `CONTRIBUTING.md` and a short doc: two disjoint histories, one
  remote, three root commits, and the practical consequences (`git fetch --all` in the terminal
  clone pulls 199 web branches; `git log --all -S…` traverses both projects). Cost: minutes. The
  cost of the situation itself does not go away.
- **B. Split.** Move the terminal to its own repo, rewrite its remotes, migrate its issues.
  Removes the trap permanently. Cost: a day, plus every terminal-labelled issue reference
  (#318, #164, #163, #162, #161, #148, #137, #136, #230, #231, #181–#184) has to keep resolving,
  and the APK build path has to be re-pointed.
- **C. Keep one remote, constrain the fetch.** A `remote.origin.fetch` refspec in each clone so
  neither sees the other's branches. Cost: an hour, but it lives in local config, so a fresh clone
  loses it and the trap returns.

**Recommendation: A now, B when the terminal next needs its own release cycle.** The measured cost
today is confusion during searches, and #149 already showed a search staying correct by luck. A
written note fixes the confusion; splitting fixes the cause, and it is not urgent enough to spend a
day on this week.

---

## #311 — A customer waiting on an unanswered request is never told, and can never withdraw it

**Decision:** when nobody answers a customer's order request, does it expire on its own, does the
customer get to withdraw it, or does it just keep waiting?

Context that constrains the answer: production currently has an open request **480 hours — 20 days
— old**. `order_requests.status` has exactly four writers, all human, and the every-2-minutes cron
sweeps `orders` only, never `order_requests`. There is no timeout, no escalation, no expiry.

- **A. Leave it.** Status quo. A request can wait forever and the customer is never told.
- **B. Tell the customer, do not auto-cancel.** Show elapsed time on the customer's screen
  ("waiting for the restaurant — 4 min"). Staff still own the outcome. Needs copy.
- **C. Customer can withdraw.** A "cancel this request" control while it is `waiting_review`.
  Needs copy and a route.
- **D. Auto-expire after N minutes**, with the customer told. Needs a reaper, and #215 says
  `order_requests` cannot have one until the claim records a timestamp — so D has a prerequisite.

**Recommendation: B and C together, not D.** Auto-cancelling risks killing a request the kitchen has
already started on informally, and D is blocked behind #215 anyway. B+C give the customer both
information and an exit without inventing a policy about what "too long" means. If you want D as
well, it is a separate piece of work after #215.

**What I need from you if you pick B or C:** the wording. Everything else is mechanical.

---

## #289 — Should the browse body still say "No items found" during a total menu outage?

**Decision:** during a *total* menu outage while the customer is searching, does the body keep
saying "No items found", or say the menu did not load?

The line is a **recorded decision** in `lib/menu/menu-body-state.ts` — *"While searching, a stale
notice must not displace the 'no results' wording"* — which is why this is escalated rather than
fixed. It reads as though it was made about a **partial** failure, where items did load and the
search legitimately matched none. A total outage is a state the wording does not appear to have
contemplated. Since #224 a banner above the body already carries the outage and its retry.

- **A. Leave it.** The banner carries the truth; the body's wording is redundant, not misleading in
  context.
- **B. Distinguish total from partial.** Keep "No items found" when items loaded and none matched;
  say the menu did not load when nothing loaded at all. Needs copy for the second case.

**Recommendation: B.** "No items found" during a total outage is a false statement about the
restaurant's menu, and the customer may conclude the kitchen has nothing rather than that the app
failed. The recorded decision is still right for the case it was written about, so this narrows it
rather than overturning it — which is why it needs your word and not mine.

---

## #274 — Should an out-of-stock item render greyed on the QR menu, or disappear?

**Decision:** does an out-of-stock dish stay visible and greyed with an "Out of stock" badge, or
vanish from the menu like an inactive item?

Current production behaviour is greyed-and-visible (`out_of_stock: { visible: true, chargeable:
false }`), live on Riviera right now — Duck Confit, N$380. Three render sites in
`browse/page.tsx` already handle it deliberately.

- **A. Keep it greyed** (current). The customer learns the dish exists, can ask staff, can come
  back. Cost: the menu advertises something unavailable and it takes up list space.
- **B. Hide it.** Matches `inactive`/`hidden`. Cost: a regular looking for their usual order sees it
  silently missing with no explanation, and staff get asked anyway.
- **C. Greyed, but sorted to the bottom of its category.** Keeps the information, stops it
  displacing orderable dishes.

**Recommendation: A — change nothing.** It is deliberate, shipped, and working, and B trades a
visible honest "unavailable" for an invisible one. C is a genuine improvement but it is a new
sorting rule across three render sites for a cosmetic gain; only worth it if you are hearing
complaints. The cheapest correct answer here is to close the issue as "working as intended".

---

## #270 — Post-order customer feedback (requested by the Riviera owner)

**Decision:** is the customer reviewing *an order* or *a visit*, and are we building it now at all?

Three things make the obvious implementation wrong, and each is yours rather than mine:

1. **There is no customer identity and no address.** `orders` has no `customer_email` column —
   zero matches across 198 refs and 144 commits. A diner is a `session_id` in `sessionStorage` that
   `clearTabSession` can destroy. So a review **cannot be emailed and cannot be solicited after the
   customer closes the tab.** Whatever this becomes must happen while the session still lives.
2. **"After the order is done" is ambiguous.** `orders.status` reaches `completed`,
   `payment_status` reaches `paid`, a tab reaches `settled` — three different moments at two
   different grains, because one settlement covers several orders (`payment_events.order_ids` is
   `uuid[]`).
3. A per-restaurant settings toggle implies a settings surface this does not have yet.

- **A. Not now.** Record the constraints, tell the Riviera owner what it depends on, revisit when
  there is a customer identity.
- **B. Order-level, in-session.** A prompt on the confirmation or My Orders screen while the session
  is alive. Smallest thing that works. Reviews one dish-order, not the evening.
- **C. Visit-level, at settlement.** Prompt when the tab settles — closer to what an owner means by
  "a review", but it lands exactly when the customer is leaving, and the session may already be
  gone.

**Recommendation: B, scoped explicitly as "rate this order", plus telling the owner that a
visit-level review needs customer identity first.** C is what was actually asked for and it is the
one the current model cannot support honestly. A is defensible if there is no appetite for a
half-answer.

---

## Summary — five one-word answers is enough

| issue | question | my recommendation |
|---|---|---|
| #319 | split the repo, or document the shared remote? | **A** — document now, split later |
| #311 | expire, withdraw, or just wait? | **B + C** — tell them, let them withdraw, no auto-expiry |
| #289 | "No items found" during a total outage? | **B** — distinguish total from partial |
| #274 | out-of-stock greyed or gone? | **A** — keep it greyed, close as intended |
| #270 | order-level or visit-level review? | **B** — order-level in-session, or **A** if not now |

#311, #289 and #270-B additionally need **copy**, which under the standing rule ships as
`PENDING COPY` or not at all.
