-- #251 — record the receipt line contract in the data dictionary. NO ROWS ARE TOUCHED.
--
-- WHY THIS MIGRATION IS ONLY A COMMENT, AND WHAT IT IS FOR
--
-- `receipt_documents.snapshot_json` is jsonb, so #251's widening of `ReceiptLineItem` needs no
-- DDL: `line_subtotal`, `line_tax`, `tax_rate_percentage` and `tax_inclusive` simply start
-- appearing on lines issued from now on. There is nothing to ALTER. What the database CANNOT
-- currently express — and what cost real time to rediscover — is that the same column holds two
-- incompatible shapes and that the older one must not be converted.
--
-- THE MEASUREMENT, taken read-only against production on 2026-08-27. 1,805 issued receipts,
-- each classified by comparing its summed snapshot_json->line_items[].line_total against the
-- order's gross total and its ex-VAT subtotal, with the orders where those two coincide split out:
--
--     ZERO-VAT (both bases identical)   984   2026-07-20 .. 2026-08-25
--     EX-VAT                            820   2026-07-23 .. 2026-08-25
--     GROSS                               1   2026-08-26 .. 2026-08-26
--     neither                             0
--
-- 820 receipts state the ex-VAT figure in a column a customer reads as the amount charged, under
-- the same `renderer_version` as the gross ones, with nothing on the document saying which.
-- RCT-001838 (2026-08-25) reads `1 x N$20.00 ... N$17.39` on a N$20.00 sale.
--
-- NO BACKFILL. Converting those 820 means re-deriving the split from `orders.items`, and issue
-- #251 rules that a decision, not an implementation choice — the same hazard as reissuing an old
-- receipt (#234): the receipt snapshot is built at ISSUANCE, so anything recomputed today carries
-- today's assumptions. There is no `updated_at` on `tax_rates` at all, so a rate that has since
-- changed leaves no trace and a recomputation cannot even detect that it is wrong. Application
-- code refuses to guess: `receiptLineVatBasis()` in lib/receipts/issueReceipt.ts returns null for
-- every row that lacks the split, rather than dividing by whatever `tax_rates` holds now.
--
-- REVERSIBLE. `COMMENT ON COLUMN ... IS NULL` removes it. Idempotent: re-running replaces the
-- comment rather than erroring, so it is safe under a repeat apply.

COMMENT ON COLUMN public.receipt_documents.snapshot_json IS
  'Frozen SALE_RECEIPT snapshot (lib/receipts/issueReceipt.ts ReceiptSnapshot). TWO LINE SHAPES '
  'EXIST. Lines issued from #251 onward carry line_subtotal / line_tax / tax_rate_percentage / '
  'tax_inclusive beside the gross line_total and are self-describing. Lines issued before it carry '
  'line_total ALONE, and its VAT basis is UNKNOWN: on production, 820 of the 1,805 receipts issued '
  'up to 2026-08-26 hold the EX-VAT figure there and 1 holds the gross figure, under the same '
  'renderer_version. Do NOT infer the basis from issued_at, and do NOT recompute it from tax_rates '
  '- that table is mutable and has no updated_at, so a recomputation would backdate a current rate '
  'onto a historical sale without leaving a trace. Backfilling the older rows requires a ruling '
  '(issue #251). Read a line''s basis only via receiptLineVatBasis(), which returns null when it '
  'is not stored.';
