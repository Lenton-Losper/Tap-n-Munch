# FNB ChowNow Jul 28 revenue gap — orders #651 / #653 / #664

**Restaurant:** FNB ChowNow (`b161c758-582d-4dfa-839a-9fa35c492a49`)  
**Day:** 2026-07-28 (UTC placed_at window)  
**Reported paid total:** N$1242.50  
**Stated expected:** N$1276  
**Stated gap:** N$33.50  

Investigation had **not** been started earlier in this agent thread; completed now after `git pull origin main` → `9e7c043`.

---

## Verdict

| Order | FlashTap before | Finatic `order.query` | Classification |
|------:|-----------------|------------------------|----------------|
| **#651** (N$34) | `cancelled` / `payment_declined`, MO `FT17852194685027284` | **`paid: true`** (trans confirmed; psn/voucher `07281344461855620704`) | **False-cancellation of a real charge (#635 pattern)** |
| **#653** (N$36) | `cancelled` / `payment_declined`, MO `FT17852198921849786` | **`E04111` Merchant order number is invalid** | **Genuine decline / no captured Finatic order** under that MO |
| **#664** (N$25) | `cancelled` / `payment_declined`, MO `FT17852227587355298` | **`E04111`** | **Genuine decline / no captured Finatic order** |
| (#637 N$29, adjacent) | `pending` / MO `FT17852173465110872` | **`E04111`** | Not in the three named orders; **no Finatic capture** under MO — still pending |

**The revenue gap is explained by #651 (N$34), not by #653 or #664.**

---

## Gap arithmetic

| Figure | Amount |
|--------|-------:|
| Paid sum before correction (31 orders) | **1242.50** |
| + #651 false-cancel | **+34.00** |
| **Reconciled paid sum after correcting #651** | **1276.50** |
| Your stated expected | 1276.00 |
| Delta vs your expected | **−0.50** |

Notes:

- There is **no** order totaling **33.50**. The 33.50 figure is only `1276 − 1242.50`.
- Day includes half-rand **#661 = 63.50**. True card-paid book after #651 fix is **1276.50**, not 1276. The 0.50 likely came from omitting that half-rand in the expected till figure.

**#653 + #664 are not part of the gap** — Finatic has no payable order for those MOs.

---

## Per-order detail

### #651 — false-cancel (real money)

| Field | Value |
|--------|--------|
| id | `af6007bf-9aaa-4e83-a313-972e91e5aa2c` |
| total | 34 (Boerewors + Vetkoek×2) |
| placed_at | `2026-07-28T06:17:46Z` |
| cancelled_at | `2026-07-28T06:18:14Z` (~28s) |
| reason | `payment_declined` |
| audit | `payment.failed` with `FT-FAIL-1785219491827`, terminal `fd7f9286-…` |
| MO | `FT17852194685027284` |
| Finatic | reconcile → `{"ok":true,"paid":true,"source":"query"}` |

Same class as **#635** (terminal reported decline; Finatic had Purchase Successful).

**Correction applied (support):** restored `completed`/`paid`, cleared cancel fields, set reference/voucher to Finatic ids, wrote `payment.completed` audit `source=manual_support_correction`.  
Receipt document: **not yet issued** (`receipt_documents` empty for this order) — optional follow-up.

### #653 — genuine decline (no Finatic capture)

| Field | Value |
|--------|--------|
| total | 36 |
| placed → cancel | `06:24:50Z` → `06:25:26Z` (~36s) |
| reason | `payment_declined` + `payment.failed` audit |
| MO | `FT17852198921849786` |
| Finatic | `E04111` invalid merchant order number |

Prepare-payment minted an MO; Finatic has nothing queryable under it → treat as **decline / aborted attempt**, not silent capture.

### #664 — genuine decline (no Finatic capture)

| Field | Value |
|--------|--------|
| total | 25 |
| placed → cancel | `07:12:35Z` → `07:12:42Z` (~7s) |
| reason | `payment_declined` + `payment.failed` audit |
| MO | `FT17852227587355298` |
| Finatic | `E04111` |

Same as #653.

---

## Method

1. Production DB: full order rows + `audit_logs` for #651/#653/#664 (+ #635 reference, #637 adjacent pending).
2. Finatic: authenticated `POST /api/payments/reconcile` as ChowNow owner (live `order.query` on production Worker).
3. #651 confirmed paid → full row correction (reconcile alone left hybrid `status=cancelled` + `payment_status=paid`).

No gateway-key rotate / Worker deploy in this pass.

---

## Bottom line

- **Missing from the 1242.50 report as a real take:** **#651 (N$34)** — false-cancellation; now marked paid.  
- **#653 and #664:** not real Finatic captures (`E04111`) — do **not** add to revenue.  
- **Reconciled FlashTap paid total for Jul 28:** **N$1276.50**.  
- Your **N$33.50** gap math tracks `1276 − 1242.50`; the actual missing charge is **N$34**, and the true book is **0.50** above 1276 because of **#661 (63.50)**.
