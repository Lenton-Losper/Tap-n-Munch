-- @env: both
--
-- AN INVOICE CAN BILL FOR A WHOLE TAB, AND SAYS WHICH ORDERS IT COVERS AND WHAT WAS NOT CHARGED.
--
-- ================================================================================================
-- WHY
-- ================================================================================================
--
-- 20260913100000 linked a document to ONE order. A tab is several orders, and an amended tab's
-- surviving quantities live on REPLACEMENT orders that `amend_order_lines` (20260829150000)
-- inserts beside the original. An invoice for "the table's bill" therefore has to name a set of
-- orders, not one.
--
--   tab_id                the tab a tab invoice bills for. NULL for order invoices and for every
--                         hand-written document.
--   order_ids             the orders the invoice covered AT ISSUE. A round added to the tab
--                         afterwards is a new order that this invoice does not bill for, and the
--                         application's "one live invoice per order" check reads this array to
--                         know which orders are already billed. NULL for order invoices (order_id
--                         says it) and for hand-written documents.
--   cancelled_line_items  lines that were ordered and then voided or cancelled, shown on the
--                         invoice as "Cancelled - not charged". Kept OUT of `line_items` on
--                         purpose: every reader of line_items (the engine's VAT maths, the
--                         renderer's totals, correct_invoice's credit note) treats a line as
--                         charged, and a zero-value line there reads as "given free" rather than
--                         "cancelled". NULL means none.
--
-- ================================================================================================
-- SAFETY
-- ================================================================================================
--
-- Additive and nullable. Nothing is backfilled; no existing row changes meaning (NULL is the truth
-- for every document that exists today). No constraint, no default, no data write -- pure DDL, so
-- scripts/check-migration-no-data-write.mjs is satisfied. correct_invoice() is taught to carry the
-- three columns in the SEPARATE file 20260928140100, for the same reason 20260913100100 was split
-- from 20260913100000.
--
-- DEPLOY ORDER: apply BEFORE the code that writes these columns. The application writes them only
-- for tab invoices and for invoices with cancelled lines; hand-written documents and plain order
-- invoices never name them, so those keep working either side of the apply.

ALTER TABLE public.business_documents
  ADD COLUMN IF NOT EXISTS tab_id uuid REFERENCES public.tabs(id),
  ADD COLUMN IF NOT EXISTS order_ids uuid[],
  ADD COLUMN IF NOT EXISTS cancelled_line_items jsonb;

COMMENT ON COLUMN public.business_documents.tab_id IS
  'The tab a tab invoice bills for. NULL for order invoices and hand-written documents.';
COMMENT ON COLUMN public.business_documents.order_ids IS
  'Orders a tab invoice covered at issue. Read by the one-live-invoice-per-order check.';
COMMENT ON COLUMN public.business_documents.cancelled_line_items IS
  'Voided/cancelled lines shown as not charged. Never part of line_items, subtotal, VAT or total.';

CREATE INDEX IF NOT EXISTS business_documents_tab_id_idx
  ON public.business_documents (tab_id)
  WHERE tab_id IS NOT NULL;
