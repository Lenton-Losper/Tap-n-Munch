-- Recovered 2026-08-05 from the staging migration ledger (issue #143). Applied to staging ad hoc
-- and never committed, which the drift guard reported as undocumented drift. Reconstructed verbatim
-- from supabase_migrations.schema_migrations.statements so this file says exactly what staging ran.
-- NOT yet applied to production.

-- Post-Payment Order Lifecycle ADR: document_sequences, invoice_requests, order_revisions.
-- Adds restaurants.short_code for document number prefixes (RIV, FNB).

ALTER TABLE public.restaurants ADD COLUMN IF NOT EXISTS short_code text;

UPDATE public.restaurants SET short_code = 'RIV' WHERE id = '01bf27f1-a958-4322-bb3e-cc5240987808';

UPDATE public.restaurants SET short_code = 'FNB' WHERE id = 'b161c758-582d-4dfa-839a-9fa35c492a49';

-- =====================================================================
-- Migration: Post-Payment Order Lifecycle
-- ADR: Post-Payment Order Lifecycle (Rev 2)
-- Introduces: document_sequences, invoice_requests, order_revisions
-- Idempotent: safe to re-run (IF NOT EXISTS / OR REPLACE / DROP+CREATE
-- for triggers, matching baseline migration conventions)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Shared document numbering sequence
--    Generic counter so future document types (quotes, receipts, GRVs)
--    reuse the same per-restaurant sequential numbering pattern already
--    established for GRV-000001 in Stock Control.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_sequences (
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  sequence_type   text NOT NULL,           -- e.g. 'invoice'
  current_number  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, sequence_type)
);

-- Atomically reserves the next number for a restaurant + sequence type
-- and formats it as PREFIX-CODE-000001. Row-level lock via the upsert
-- prevents two concurrent invoice requests from getting the same number.
CREATE OR REPLACE FUNCTION generate_document_number(
  p_restaurant_id  uuid,
  p_restaurant_code text,   -- short per-restaurant code, e.g. 'RIV', 'FNB'
  p_sequence_type  text,    -- e.g. 'invoice'
  p_prefix         text     -- e.g. 'INV'
) RETURNS text AS $$
DECLARE
  v_next integer;
BEGIN
  INSERT INTO document_sequences (restaurant_id, sequence_type, current_number)
  VALUES (p_restaurant_id, p_sequence_type, 1)
  ON CONFLICT (restaurant_id, sequence_type)
  DO UPDATE SET current_number = document_sequences.current_number + 1
  RETURNING current_number INTO v_next;

  RETURN p_prefix || '-' || p_restaurant_code || '-' || LPAD(v_next::text, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- 2. invoice_requests
--    Owned by the Document Service. Deliberately kept separate from
--    `orders` so the core order schema is never widened with
--    invoicing-only fields (company_name, vat_number, GL/cost-centre
--    metadata etc.)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  payment_id       uuid REFERENCES payments(id),

  -- Idempotency: derived from the payment/provider transaction reference.
  -- A duplicate payment.completed delivery for the same payment must
  -- resolve to the same invoice_requests row, not a new one.
  idempotency_key  text NOT NULL,

  invoice_number   text,             -- assigned once generation starts (INV-RIV-000001)
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'generating', 'sent', 'failed')),

  -- Universal fields (present for every invoice, any tenant)
  company_name     text,
  vat_number       text,
  email            text NOT NULL,

  -- Tenant-specific corporate fields (FNB: department/GL number/employee
  -- code/cost centre/business unit; future tenants: whatever they need).
  -- Hybrid schema per mentor decision: universal columns + JSON overflow.
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,

  pdf_url          text,             -- storage path once generated
  failure_reason   text,
  retry_count      integer NOT NULL DEFAULT 0,

  requested_at     timestamptz NOT NULL DEFAULT now(),
  generated_at     timestamptz,
  sent_at          timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invoice_requests_idempotency_key_unique UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_invoice_requests_order_id      ON invoice_requests(order_id);

CREATE INDEX IF NOT EXISTS idx_invoice_requests_restaurant_id ON invoice_requests(restaurant_id);

CREATE INDEX IF NOT EXISTS idx_invoice_requests_status        ON invoice_requests(status);

-- updated_at maintenance (reuse the shared touch-trigger function if one
-- already exists in the codebase; this is provided in case it doesn't)
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_invoice_requests_updated_at ON invoice_requests;

CREATE TRIGGER trg_invoice_requests_updated_at
BEFORE UPDATE ON invoice_requests
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------
-- 3. order_revisions
--    Owned by the Order Service. Amendments are append-only revisions,
--    never in-place edits — audit trail is a diff between revisions,
--    not a separately maintained log.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_revisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  order_id         uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  revision_number  integer NOT NULL,     -- auto-assigned by trigger below (omit on INSERT)

  -- ADR draft references staff_users; FlashTap schema table is staff_members.
  amended_by       uuid NOT NULL REFERENCES staff_members(id),
  reason           text,                 -- optional manager note

  -- Structured diff, one entry per affected line item:
  -- [{ "item_id": "...", "action": "removed" | "added" | "quantity_changed" | "discount_applied",
  --    "quantity_delta": -1, "price_delta": -45.00,
  --    "stock_action": "reversed" | "waste" | "none" }]
  changes          jsonb NOT NULL,

  financial_delta  numeric(10,2) NOT NULL DEFAULT 0,

  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_revisions_order_revision_unique UNIQUE (order_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_order_revisions_order_id ON order_revisions(order_id);

-- Auto-assigns the next revision_number per order. NOTE: under genuinely
-- concurrent amendments to the same order this has a race window;
-- if that's a realistic scenario (two managers amending simultaneously),
-- wrap the insert in `SELECT ... FOR UPDATE` on the parent order row,
-- or take a pg_advisory_xact_lock(order_id) before insert.
CREATE OR REPLACE FUNCTION set_order_revision_number() RETURNS trigger AS $$
BEGIN
  IF NEW.revision_number IS NULL THEN
    SELECT COALESCE(MAX(revision_number), 0) + 1 INTO NEW.revision_number
    FROM order_revisions
    WHERE order_id = NEW.order_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_order_revision_number ON order_revisions;

CREATE TRIGGER trg_set_order_revision_number
BEFORE INSERT ON order_revisions
FOR EACH ROW EXECUTE FUNCTION set_order_revision_number();

-- ---------------------------------------------------------------------
-- 4. Row-Level Security
-- ---------------------------------------------------------------------
ALTER TABLE invoice_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE order_revisions  ENABLE ROW LEVEL SECURITY;

-- invoice_requests: staff can view/manage invoices for their own
-- restaurant. No public/guest INSERT policy — creation happens
-- exclusively through the validated service-role API route at
-- checkout, consistent with "never trust the client" and the existing
-- guest-facing-reads-via-service-role pattern from the security
-- remediation work. Staff CAN update status (e.g. manual retry).
CREATE POLICY staff_view_invoice_requests ON invoice_requests
  FOR SELECT
  USING (restaurant_id IN (SELECT user_restaurant_ids()));

CREATE POLICY staff_update_invoice_requests ON invoice_requests
  FOR UPDATE
  USING (restaurant_id IN (SELECT user_restaurant_ids()))
  WITH CHECK (restaurant_id IN (SELECT user_restaurant_ids()));

-- order_revisions: staff-only, scoped to their restaurant. Amendments
-- are always a staff (Manager-permissioned) action, never guest-facing,
-- so a normal staff-scoped INSERT policy is appropriate here (unlike
-- invoice_requests, which goes through the service role because it can
-- be triggered from the guest-facing checkout flow).
CREATE POLICY staff_view_order_revisions ON order_revisions
  FOR SELECT
  USING (restaurant_id IN (SELECT user_restaurant_ids()));

CREATE POLICY staff_insert_order_revisions ON order_revisions
  FOR INSERT
  WITH CHECK (restaurant_id IN (SELECT user_restaurant_ids()));

-- Permission-level gating (orders:amend / orders:refund) still happens
-- in the authorize() layer per Authorization v2 — RLS here is tenant
-- isolation, not the permission check itself.;
