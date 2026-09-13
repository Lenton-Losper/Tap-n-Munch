-- @env: both
--
-- LINK A BUSINESS DOCUMENT TO THE ORDER IT BILLS FOR.
--
-- ================================================================================================
-- WHAT THIS IS FOR
-- ================================================================================================
--
-- The document engine (quotes, invoices, credit notes) has never had any relationship to `orders`.
-- Line items are typed in by hand, so an invoice for a meal that FlashTap already recorded had to
-- be re-keyed from the order, with no way afterwards to say which order a document billed for.
--
-- The outlet manager's requirement, clarified 2026-09-13, is a FORMAL INVOICE raised from an
-- existing order. That needs exactly one thing the schema does not have: a link.
--
-- ================================================================================================
-- NULLABLE, AND THAT IS NOT A COMPROMISE
-- ================================================================================================
--
-- Hand-written quotes and invoices are a real and continuing use of this engine -- production holds
-- four such documents today, none of which came from an order. They must keep working untouched, so
-- the column is nullable and nothing is backfilled. An absent link means "not raised from an order",
-- which is the truth for every row that exists today.
--
-- ================================================================================================
-- DELIBERATELY NOT UNIQUE
-- ================================================================================================
--
-- One order can legitimately own SEVERAL documents, and a unique index would break the correction
-- path on its first use:
--
--     invoice #12          raised from order X
--     invoice #13          the correction, supersedes #12, same order X
--     credit note #4       cancels #12, same order X
--
-- `correct_invoice()` creates all three in one transaction. Uniqueness on `order_id` would abort it.
-- Guarding against a careless SECOND invoice for the same order is therefore an APPLICATION concern
-- -- it has to distinguish a correction from a duplicate, which an index cannot -- and it lives in
-- lib/documents/create-invoice-from-order.ts.
--
-- ================================================================================================
-- correct_invoice() IS UPDATED SEPARATELY, IN 20260913100100
-- ================================================================================================
--
-- That function INSERTs the replacement invoice and the credit note with an EXPLICIT column list,
-- so it does not carry a new column: an order-linked invoice, once corrected, would produce a
-- replacement and a credit note with `order_id IS NULL` and sever the lineage from the order at
-- exactly the moment the paper trail matters most.
--
-- It is a SEPARATE FILE because scripts/check-migration-no-data-write.mjs refuses to see an
-- ALTER TABLE and an INSERT in one migration, and it is right to: the rule cannot tell a write to
-- live rows from an INSERT inside a function BODY, and the safe reading of an ambiguous money-
-- adjacent rule is the strict one. Splitting costs nothing and is what the rule asks for --
-- separate files, separate approvals.
--
-- No data is written here. Pure DDL.

ALTER TABLE public.business_documents
  ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES public.orders(id);

COMMENT ON COLUMN public.business_documents.order_id IS
  'The FlashTap order this document bills for. NULL for hand-written documents. Not unique: a '
  'correction and its credit note share the original''s order.';

-- Partial, matching the shape the lineage columns already use in 20260725200000: the index exists
-- to answer "which documents bill for this order", and rows with no link are never that answer.
CREATE INDEX IF NOT EXISTS business_documents_order_id_idx
  ON public.business_documents (order_id)
  WHERE order_id IS NOT NULL;
