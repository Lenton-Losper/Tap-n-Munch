# QR ordering — manual test script (pre-launch)

Everything automated testing could reach was covered at API and database level on staging.
This script covers **only what automation could not**: how the flow behaves in a real browser
on a real phone. No Chrome extension was paired to the automation account, so nothing below
has been verified by anyone yet — treat every box as genuinely unknown.

**Environment:** staging — `https://flashtap-staging.llosperofficial.workers.dev`
**Device:** a real phone on mobile data, not desktop Chrome. Several of these only misbehave
on a flaky connection or when a mobile browser evicts a backgrounded tab.
**Time needed:** ~30 minutes solo, ~45 with a second person for the shared-table cases.

Record for each step: what you expected, what happened, and a screenshot if they differ.
A step that is merely *ugly* still counts as a failure worth writing down.

---

## Before you start

1. Pick a test table and note its number. Do not use a table a real customer might scan.
2. Have a second phone (or ask a colleague) for section 5.
3. If anything charges money, stop and report it — the customer flow should never reach a
   real payment. Money moves on the staff terminal only.

---

## 1. Happy path

| # | Do this | Expect | OK? |
|---|---|---|---|
| 1.1 | Scan the table QR | Menu loads; correct restaurant name and table number | ☐ |
| 1.2 | Browse to a category and open an item | Prices and options render; no raw ids or `undefined` | ☐ |
| 1.3 | Add 2 items to the cart | Cart badge/count updates immediately | ☐ |
| 1.4 | Open the cart | Both items, correct quantities, correct total | ☐ |
| 1.5 | Place the order | Clear confirmation. **Note the exact wording.** | ☐ |
| 1.6 | Open the Tab page | **The order you just placed is listed.** This is the fix deployed tonight — if the tab is empty, that is a regression; report it immediately. | ☐ |
| 1.7 | Open My Orders | Same order appears here too | ☐ |
| 1.8 | Note the tab total | Does it include the order you just placed? A total that excludes it is a known open defect — confirm whether you see it. | ☐ |

## 2. Abandoning and coming back

| # | Do this | Expect | OK? |
|---|---|---|---|
| 2.1 | Build a cart, don't submit. Lock the phone for 5 minutes. Unlock. | Cart still intact, or a clear message that it expired — not a silent empty cart | ☐ |
| 2.2 | Build a cart, close the browser tab entirely, rescan the QR | State is either restored or cleanly reset. Note which. | ☐ |
| 2.3 | After 2.2, place an order | **Exactly one** order appears on the Tab, not two | ☐ |
| 2.4 | Switch to another app for 10+ minutes, then return | Page recovers, or reloads cleanly. It must not sit on a spinner. | ☐ |

## 3. Poor connection

Use airplane mode to cut the connection at precise moments.

| # | Do this | Expect | OK? |
|---|---|---|---|
| 3.1 | Tap Place Order, then immediately enable airplane mode | A clear failure message with a way forward. **Not** an infinite spinner. | ☐ |
| 3.2 | Restore connection, check the Tab | Either the order went through **once**, or not at all. Never twice. | ☐ |
| 3.3 | If 3.1 showed an error, tap retry | Still exactly one order on the Tab | ☐ |
| 3.4 | Load the menu on a deliberately weak signal | Loading states appear and resolve; nothing hangs indefinitely | ☐ |

⚠️ 3.2 and 3.3 target a known open defect: the duplicate-protection key is per-browser-tab, so
recovering in a **new** tab can create a second order. Reproducing it here confirms the
real-world impact.

## 4. Double submission

| # | Do this | Expect | OK? |
|---|---|---|---|
| 4.1 | Tap Place Order twice, fast | One order. Button should disable or the second tap be ignored. | ☐ |
| 4.2 | Place an order, then hit browser Back | No re-submission; no duplicate on the Tab | ☐ |
| 4.3 | Place an order, then pull-to-refresh the confirmation screen | No duplicate | ☐ |

## 5. Two people at one table

Needs a second phone. **This exercises the bug fixed tonight — worth doing carefully.**

| # | Do this | Expect | OK? |
|---|---|---|---|
| 5.1 | Both phones scan the same table QR at the same time | Both join successfully | ☐ |
| 5.2 | Check the member list on both | **Both people appear on both phones.** A missing person is the bug that was fixed — report immediately if seen. | ☐ |
| 5.3 | Have 3–4 people scan simultaneously if you can | Everyone appears; nobody silently vanishes | ☐ |
| 5.4 | Each person orders something different | Each sees their own order; the tab total reflects both | ☐ |
| 5.5 | Check the names shown | Real names, or sensible "Person 2"/"Person 3" — no duplicates, no blanks or dashes | ☐ |

## 6. Session ending underneath the customer

| # | Do this | Expect | OK? |
|---|---|---|---|
| 6.1 | With a customer mid-order, have staff Close Table | Customer gets a clear "session ended, please rescan" message — not a raw error or a dead screen | ☐ |
| 6.2 | Customer taps around after 6.1 | Every action gives the same clear message; nothing looks broken | ☐ |
| 6.3 | Place an order, then have staff Close Table before accepting it | ⚠️ Known open defect: the order is stranded — never served, never billed, customer never told. Confirm what the customer actually sees. | ☐ |
| 6.4 | Rescan the QR after 6.1 | Fresh session starts cleanly | ☐ |

## 7. Back button and navigation

| # | Do this | Expect | OK? |
|---|---|---|---|
| 7.1 | Press Back at each stage: menu → item → cart → confirmation | Sensible destination each time; never a blank screen | ☐ |
| 7.2 | Back immediately after ordering | No re-submission, no confusing state | ☐ |
| 7.3 | Use Back to reach a page from an ended session | Clear message, not a crash | ☐ |

## 8. Error wording

Read every message a customer could see and judge it as a customer, not a developer.

| # | Check | OK? |
|---|---|---|
| 8.1 | No message shows a raw error code, stack trace, `undefined`, or a UUID | ☐ |
| 8.2 | Every failure tells the customer what to do next | ☐ |
| 8.3 | No message names an internal system (PayCloud, Finatic, Supabase) | ☐ |
| 8.4 | No browser `alert()` popups — My Orders is known to use one when no session exists | ☐ |
| 8.5 | Every spinner eventually resolves or fails; none spin forever | ☐ |

---

## Reporting

For each failure, capture: **what you did → what you expected → what happened**, plus a
screenshot and roughly when. The exact wording of any confusing message is the most useful
thing you can record — that is precisely what automated testing could not judge.

Flag immediately, before finishing the script:
- Any duplicate order
- Any missing person on a shared tab
- Any wrong money figure
- Any screen with no way forward
