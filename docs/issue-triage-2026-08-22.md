# Issue triage — 2026-08-22

**106 open issues, not 109.** `gh issue list --state open --limit 300` returns 106; oldest 2026-07-07,
newest 2026-08-21. If you are counting 109, three are closed or live somewhere other than this repo.

## How to read this, including where it is weak

Every row carries a **verification level**, because the depth is not uniform and pretending otherwise
would be the exact failure you asked me to avoid:

| level | meaning |
|---|---|
| **CODE** | I ran a check against the tree this pass and quote what it returned. |
| **SESSION** | Established and evidenced earlier in this session's work, usually with production measurement. |
| **TITLE** | Classified from the issue's own title/label ONLY. Used for feature requests, where no code check changes the verdict. |
| **UNVERIFIED** | Not checked this pass. The verdict is provisional and says what would settle it. |

Nothing here was fixed. Where a fix exists on staging, the verdict is **BLOCKED ON A DEPLOY**, which
is a sixth bucket your five did not have and which several issues need — the code is written, tested
and unpromotable until a wave lands.

---

## 1. LIVE DEFECTS, ranked

Ranked by your criteria in order: **touches money → a client sees it → accruing daily.**

| rank | issue | money | client sees | accruing | level |
|---|---|---|---|---|---|
| 1 | **#107** PayCloud signature fails on ~100% of traffic | ✅ | — | ✅ | SESSION |
| 2 | **#236** `pin_required=true` + NULL `tab_pin` disables the PIN check | ✅ | ✅ | ✅ | CODE |
| 3 | **#279** open orders released on table number alone | ✅ | ✅ | ✅ | CODE |
| 4 | **#127** duplicate order numbers, no unique constraint | ✅ | ✅ | ✅ | SESSION |
| 5 | **#170** `document_sequences` defined twice, incompatibly | ✅ | — | — | CODE |
| 6 | **#325** Order History shows TABLE as `0` for every POS row | — | ✅ | ✅ | CODE |
| 7 | **#324** 1315 orders with `restaurant_id = NULL` | ✅ | — | — | SESSION |
| 8 | **#284 / #262** anon `tabs` exposure | — | ✅ | ✅ | CODE |
| 9 | **#260** the E04111 source doc exists on no branch | — | — | — | CODE |

**#107 is first and is not fixable by us.** Measured today against live production `order.query`:
every response failed verification with `Encryption block is invalid.`, in an environment whose keys
are correctly *distinct*. No key we hold verifies a production response. Consequence:
`fallback_verified_paid` is the primary settlement path, indefinitely. See §4.

**#236 — repro, from code.** `app/api/tabs/[tabId]/join/route.ts:162` and
`app/api/tabs/[tabId]/route.ts:81` both compute:

```ts
const pinRequired = tabData.pin_required !== false && Boolean(tabData.tab_pin)
```

A tab with `pin_required = true` and `tab_pin = NULL` yields `Boolean(null) === false`, so
`pinRequired` is **false** and the PIN check is skipped entirely. Setting the flag without a PIN
**disables** protection rather than enforcing it. The issue's claim is confirmed verbatim.

**#279 — repro, from code.** `lib/guest-orders/validation.ts:43` — the ownership branch admits a row
on `table != null && Number(...)`, and the file's own docblock says "Open orders require restaurant
binding PLUS table_number or session_id." A table number is printed on the QR stand: it is a public
value being used as a capability.

**#325 — repro.** `components/order-history/order-history-content.tsx:614` renders
`{order.table_number ?? '—'}`. `??` substitutes only for null/undefined, and the terminal POS route
hardcodes `tableNumber: 0`, so **every POS row renders `0`**, not a dash.

**#170 — confirmed live and it has a second consequence.** `document_sequences` is created by both
`20260705210000_post_payment_order_lifecycle.sql` and `20260705280000_business_documents…`. That same
`20260705210000` file is one of **two migrations with no `@env:` header**, which the drift check
resolves to scope `both` → expected on production → not applied → **`exit(1)`**. Committing it to
main blocks every production deploy. Keep both files out of every wave.

**#260 — confirmed by absence.** `git log --all -- docs/finatic-questions-for-vernon.md` returns
nothing: the document cited as the source of the E04111 time-dependency model **has never existed on
any branch**. The model may still be right — order #149 is independently recorded — but the citation
is unbacked.

---

## 2. BLOCKED ON A DEPLOY — fixed, waiting on promotion

Not live defects. Do not spend time on these; they need a wave, not a fix.

| issue | where the fix is | needs |
|---|---|---|
| **#327** terminal success contract (`success: false`) | staging, wave 6 | wave 6 → main |
| **#311** customer never told about an unanswered request | staging, wave 5 | wave 5 → main |
| **#224 / #289** browse "No items found" during a total outage | staging (`fixed-on-staging`) | wave 5; **#289's copy ruling is separately yours** |
| **#206** customer toasts render raw server error text | staging (`fixed-on-staging`) | wave 3 |
| **#169** table-existence probes report ABSENT wrongly | staging (`fixed-on-staging`) | wave 2 |
| **#67** `orders.terminal_status` | migration `20260725140000` exists | verify applied, then close |
| **#314** Playwright specs blocked on `STAGING_TEST_PASSWORD` | `staging.yml:729` **on the staging branch only** | wave 2 |
| **#328** POS client sends no idempotency key | terminal repo `2300402` today | **an APK build** |

**#328 is the one with a different blocker.** The client change is committed and proved two-sided
against staging (same key → one order, different keys → two, with both controls). It ships only in a
new APK, which needs the version bump.

---

## 3. ALREADY FIXED — close on your confirmation

| issue | evidence | level |
|---|---|---|
| **#329** no cancellation trail on three cancelled orders | Cause identified: the terminal status route between `3408757` (2026-06-23) and `c1471a7` (2026-07-28) wrote `status` and nothing else. `c1471a7` **is an ancestor of main** — verified. No new rows of this shape are possible. | SESSION |
| **#91** missing `STAGING_CRON_SECRET` | `staging.yml:357` references `secrets.STAGING_CRON_SECRET` | CODE |
| **#153** stale-order cron permanent stuck class | Partly superseded: the unrecognised-status guard and skip-audit rows landed on staging. **The doc's overclaim was retracted 2026-08-22.** Not fully closed — see #158. | SESSION |

**The money half of #329 is NOT closed** — whether Finatic refunded or kept the N$201 is still
unestablished and belongs in §4. Close the *trail* half only.

---

## 4. BLOCKED EXTERNALLY

| issue | on whom | what unblocks it |
|---|---|---|
| **#107** PayCloud signature verification | **Finatic** | Their production **response-signing public key** for `order.query` on merchant `342600131153`. Ask drafted at `docs/finatic-ask-response-signing-key.md`. |
| **#329** (money half) N$201 on three cancelled orders | **Finatic** | Their statement of whether the three were refunded or retained. |
| **#170**, **#245**, **#263**, **#281**, **#280**, **#145** migration/RLS integrity | **migration freeze** | These need DDL or a ledger repair. All read-only-diagnosable, none actionable under the freeze. |
| **#198** staging has no Finatic credentials | **Finatic / config** | Real staging credentials, or a documented decision to keep using the stub. |
| **#149** critical artifacts on one machine | partly resolved | The APK cleanup ran (85 files, 4.37 GB, keystores intact). The **offsite** half is still open and is not a code task. |

---

## 5. BLOCKED ON ME — one sentence each, with options

### The two I am actively holding

**Kiosk channel filter.** The terminal order list filters by restaurant and status only, so kiosk and
customer-placed orders appear on the till with Decline live on them — that is how Digi Cofee #9 was
cancelled. *Options: (a) filter kiosk out of the till list; (b) keep them visible but read-only; (c)
leave as-is.*

**RLS `WITH CHECK` proof — RULED 2026-08-22: do not touch a real order.** The lockdown stays
**closed-as-written, not as-deployed**, and is recorded that way. The column-GRANT half *is* proven
live (`total` → `42501 permission denied`; `status` accepted, exactly as the migration reads).

### Rulings

| issue | the decision, in one sentence | options |
|---|---|---|
| **#324** | Do 1315 `restaurant_id = NULL` legacy rows get deleted, backfilled, or left in a financial table? | delete / backfill / leave + exclude from reporting |
| **#127** | The unique index on `(restaurant_id, order_number)` cannot be added while 3 real FNB ChowNow duplicates exist — renumber them or scope the index? | renumber / partial index / defer |
| **#289** | Should browse still say "No items found" during a **total** menu outage? | outage banner / keep / both by cause |
| **#282** | `session_id` leaves on guest reads and is now a capability — redact or mitigate? | redact / rotate / accept |
| **#270** | Post-order customer feedback spec — **you marked this PARKED**; confirm it stays parked. | park / revive |
| **#303** | You already ruled: leaving the unreachable refusal was right. **Close as a recorded decision.** | close / revisit |
| **#320** | Multi-location paths have never been exercised — commit to testing them before the second venue opens, or accept the risk? | test / accept |
| **#284** | Is an unscoped anon `SELECT` on `tabs`, protected only by a column grant, acceptable? | add restaurant scope / accept |

### Feature requests — prioritisation only, no code question

**#9, #10, #11, #12, #13, #14, #15, #19, #25, #58, #59, #61, #62** (level: TITLE). Thirteen product
features, none of them defects. They need a place in a roadmap, not a triage verdict. **#58**
(look up an order by Finatic merchant_order_no) is the one with operational value today — it is what
you were doing by hand during the #876 investigation.

---

## 6. STALE

| issue | why the premise no longer holds | level |
|---|---|---|
| **#303** | The refusal being unreachable was examined and **deliberately left**; the finding is now a recorded decision, not an open defect. | SESSION |
| **#153** (partly) | Its "permanent stuck class" framing was overclaimed; the overclaim is retracted in `docs/issue-e04111-cron-permanent-stuck-class.md`, and four scripts it cites exist on no branch. | SESSION |

**Only two, and I am deliberately not padding this section.** You warned that several issues this week
were stale — I found fewer than that implies, and I would rather return a short honest STALE list
than promote UNVERIFIED rows into it.

---

## 7. NOT VERIFIED THIS PASS — provisional, with what would settle each

These carry a provisional verdict from their title and label. **Do not act on them as triaged.**
Roughly forty issues, grouped by what one check would resolve them.

**Terminal-side, needs the terminal repo and probably a device** — #318, #326, #230, #231, #183,
#182, #181, #184, #164, #163, #162, #161, #148, #137, #136, #90, #82.
*Settled by:* reading `D:/RN/FlashTapTerminal` per issue; several also need an APK on a device.
`countUnpaidOrders` (#230) is confirmed to exist at `TablesScreen.tsx:36` — the cancelled-order claim
itself is unchecked.

**Pricing / menu correctness** — #117, #228, #229, #298, #247.
*Settled by:* `calculate-order-pricing.ts` returned **no match** for `variant_groups` this pass, which
is consistent with #117 and #228 both still being live and with the recorded finding that the legacy
`variants` column is what customers actually see. **Worth checking first — #117 is a launch-blocker
labelled undercharge.**

**Receipts / VAT** — #251, #250, #237, #244, #234.
*Settled by:* `sendReceiptEmail` returned no match for `rateLimit`/`dedup`, consistent with #244
being live. #237's `payment_events` read exists at `issueReceipt.ts:254`.

**Payments / ledger** — #268, #259, #258, #239, #256/#156, #157, #160, #222, #216, #215, #213, #285.
*Settled by:* one targeted read each. `reconcile-orphan-payments.ts` **does** contain two `audit_logs`
references, so #239's "no audit row at all" is likely **partly stale** — check which path.

**Infrastructure / CI** — #319, #323, #172, #196, #186, #178, #139, #145, #100, #81.
*Settled by:* mostly config reads. #323's analytics half **is** fixed (`analytics.ts` uses
`fetchAllRows`); the `history/route.ts` summary path still uses a bare `.range()` at line 171 and is
the half worth checking.

**Launch-blockers not yet re-verified** — #121, #120, #119.
*Settled by:* these are labelled `launch-blocker` and predate a lot of change. **Re-verify before the
next venue opens**, not before.

---

## What I would do first

1. **#236** — smallest fix, real security consequence, two-line change plus a test.
2. **#117** — labelled undercharge on every sized drink; verify it, because if it is live it has been
   costing money on every sale.
3. **#325** — one character (`??` → `||`), visible to you on every report.
4. **Wave 2** — inert, and it unblocks #314, #169 and the test-file conflicts in later waves.
5. **The Finatic ask** — it is drafted and costs you one email; nothing else moves #107.
