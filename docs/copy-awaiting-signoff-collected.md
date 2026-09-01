# Copy awaiting sign-off — collected food, and partial progress

**Status: DECISION REQUIRED FROM THE OWNER. Nothing below is implemented.**

`src/constants/serviceCopy.ts` is signed — *"ALL 31 STRINGS. DO NOT EDIT WITHOUT A NEW SIGN-OFF."*
This phase therefore shipped its fixes using **only the existing signed vocabulary** and wrote no
new staff-facing words. Two improvements were identified that cannot be made without new wording,
and they are recorded here rather than invented.

---

## 1. A distinct chip for collected food

### What ships today (no sign-off needed, already landed)

A collected line renders the existing **`Ready`** chip, de-emphasised — same word, fill removed.

That is not a compromise for its own sake. The server's own comment settles the equivalence:

> Serialising 'collected' as 'ready' costs nothing true: to a waiter, "picked up" and "ready" both
> mean "not still being made".

It fixes the actual defect — collected food was reading as **"Being made"** — using words the owner
has already approved.

### What is being asked for

A fourth chip so a waiter can tell *"on the pass, go and get it"* from *"already on the table"*
without reading the fill colour.

| Constant | Purpose | Suggested |
|---|---|---|
| `TABLE_LINE_COLLECTED_CHIP` | Against a line whose food has been taken off the pass. Sits beside the signed `Ready` / `Being made` / `Voided`. | `Delivered` |

Notes for the decision, not recommendations:

- `Collected` is the word the schema uses, but staff say *"run"* or *"taken"*. The chip should read
  the way the floor talks, not the way the database does.
- It must not read as a payment state. `Delivered` is close to `Paid` in a scanning eye's grouping;
  if that risks confusion, something like `On the table` separates the two ideas.
- Whatever is chosen, it is the **fourth** state on a row that already carries three. If the owner
  would rather it not be a chip at all — a tick, a struck-through row — that is equally a valid
  answer and is cheaper to render.

**Until this is signed, the shipped behaviour stands and is correct.** Nothing is blocked.

---

## 2. Partial progress on a `both`-routed line

### The measured cost of not having it

2026-09-01, Digi Cofee. `4x Coffee` was routed to **both** stations. The bar poured it and bumped;
the kitchen had never started its half. The P5 showed **"Being made"** and Ready 0 — correct, and
completely unhelpful, because the device was *holding* `bar_state: 'ready'` and
`kitchen_state: 'outstanding'` and rendering neither.

The incident was reported as a stale terminal. It was not stale. Nobody could tell, because the
screen could not say *which half* was outstanding.

### What is being asked for

Wording that says one station has finished and the other has not, against a single line.

| Constant | Purpose | Suggested |
|---|---|---|
| `TABLE_LINE_PARTIAL_CHIP` | A `both` line where exactly one station is done. `{station}` substituted with the one still working. | `Waiting on {station}` |
| `TABLE_STATION_KITCHEN` | Substituted into the above. | `kitchen` |
| `TABLE_STATION_BAR` | Substituted into the above. | `bar` |

Notes for the decision:

- The data is already on the device and already parsed. This is wording, not plumbing.
- It only applies to `both` lines, which is a small and shrinking population — the web app now
  requires an explicit acknowledgement before a category can be routed `both`, and 72 items across
  two venues are the current stock of them.
- The raw station states arrive with a collected half **downgraded to `ready`** by the server for
  older clients, so these strings can only ever answer *"has this station finished"* — never *"was
  it picked up"*. The wording must not imply the latter.

---

## What was deliberately NOT proposed

**A runner's work list / collect button on the P5.** `docs/collected-state-proposal.md` records the
owner's ruling — *"the state comes first and the screen comes after"* — and that the runner screen
is explicitly not approved. This phase built no such screen and proposes none. The two items above
are labels on rows that already exist.
