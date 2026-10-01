# Terminal latency baseline, 2026-10-01 (Phase 0 of perf/latency-sprint)

Base: production web commit **682a2b2e** (worker version 2f1de30d). Nothing in this file was measured
on changed code. Production was not touched to produce it.

## Where the time goes

The worker runs at the colo nearest the terminal (JNB/WDH). Supabase is in AWS **eu-west-1**
(Ireland). Each database round trip is therefore roughly 200 ms of network, while the query itself
takes under 1 ms. Some examples: the single-order read uses `orders_pkey` at 0.054 ms, and the
hot `audit_logs` reads take 22–36 ms (87,720 FNB rows, no `entity_id`/`action` index).

**Latency ≈ sequential depth × ~200 ms.** Depth means calls that wait for each other. Raw call
count matters much less. A Workers invocation also holds at most **six** simultaneous open
connections, so fan-out beyond six only queues.

## Baseline table

How the figures were obtained:
- **Latency:** worker logs from 2026-09-30, production, worker 2f1de30d.
- **DB calls, depth and duplicates:** read from the code at 682a2b2e.
- **"measured (harness)":** `__tests__/terminal-orders-list-latency.test.ts` run against the
  unchanged 682a2b2e sources, using FNB's real row counts.

| Route | DB calls | Sequential depth | Duplicate reads | External calls | Latency (prod) |
|---|---|---|---|---|---|
| GET /api/terminal/orders (list, no params) | ~200 at N=4,675 (code); **131** (harness) | ~100 (code); **84** (harness) | none per order; 5 sequential pages, 24 sequential sale chunks, 24 sequential financials batches | — | **p50 11.2 s**, p90 12.6 s, max 39.3 s |
| GET /api/terminal/orders?orderId= | 5–9 | 4–6 | — | — | p50 794 ms |
| POST …/prepare-payment | 9+K | ~9 | order read twice | Upstash | p50 1.8 s |
| POST …/orders/[id]/payment | 13 (walk-up), ~22–26 (tab) | ~13 / ~22 | billing profile ×2, tab orders ×3, tab updates ×3; receipt 9 sequential | — | p50 2.9 s |
| POST …/attempt-started | 5 | 5 | — | — | p50 4.5 s (≈3 s unexplained by DB depth) |
| POST /api/webhooks/paycloud | 13 | ~13 | — | — | p50 635 ms, max 4.7 s |
| POST …/verify-payment | 16 | ~14 | resolveSettlementTarget ×2, order ×3 | Upstash, Finatic | not captured |
| GET …/station-lines | 7–9 | 4 | — | — | not captured |
| GET /api/terminal/tables | 10 | 10 | `payment_events` sales/refunds read twice | — | p50 476 ms |
| heartbeat / refresh / me | 1–3 | 1–3 | — | — | 472 / 407 / 419 ms |
| cron (*/2) | — | — | — | Finatic | 27–37 s per run |

FNB ChowNow's live-order shape (production, 2026-09-30):
- completed: 4,543, of which 1,719 are older than 30 days
- pending: 131
- preparing: 1

That is about 2.5 KB per row. The no-parameter list response is **1.83 MB of JSON**, and every
terminal polls it every 30 s (`POLL_INTERVAL_MS`, OrdersScreen 2.42).

## The list call graph at 682a2b2e (what Phase 2 changes)

```
requireTerminalAuth (JWT, no I/O)
validateTerminalRecord ................................. 1 RT
autoCancelStalePosOrders (terminal path, verify=false) . 1 RT steady state (+ read/cancel/audit/void when it cancels)
fetchAllRows(orders, live statuses, placed_at desc) .... ceil(N/1000) RT, sequential
enrichOrders
  getPaymentProjections
    sales:   ceil(N/200) RT, sequential
    refunds: ceil(S/200) RT, sequential
  then financialsByOrder
    ceil(N/200) batches, sequential; each = readProjectionInputs (~3 reads, depth 2)
```

No step reads per order. The cost comes from every batch waiting on the one before it.
