-- Business documents: billing profiles, per-restaurant document sequences, issued quotes/invoices.
-- Fresh design — no dependency on recovered-wip-order-lifecycle.

-- ---------------------------------------------------------------------------
-- 1. restaurant_billing_profiles (one row per restaurant)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.restaurant_billing_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  registration_number text,
  vat_number text,
  bank_name text,
  bank_account_name text,
  bank_account_number text,
  bank_branch_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id)
);

CREATE INDEX IF NOT EXISTS restaurant_billing_profiles_restaurant_id_idx
  ON public.restaurant_billing_profiles (restaurant_id);

-- ---------------------------------------------------------------------------
-- 2. document_sequences (per restaurant, per document type)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_sequences (
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  current_number integer NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, document_type),
  CONSTRAINT document_sequences_document_type_check
    CHECK (document_type IN ('quote', 'invoice'))
);

-- Atomically reserve the next sequence number (safe under concurrent callers).
CREATE OR REPLACE FUNCTION public.get_next_document_number(
  p_restaurant_id uuid,
  p_document_type text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_next integer;
BEGIN
  IF p_document_type NOT IN ('quote', 'invoice') THEN
    RAISE EXCEPTION 'Invalid document_type: %', p_document_type;
  END IF;

  INSERT INTO public.document_sequences (restaurant_id, document_type, current_number)
  VALUES (p_restaurant_id, p_document_type, 0)
  ON CONFLICT (restaurant_id, document_type) DO NOTHING;

  UPDATE public.document_sequences
  SET current_number = current_number + 1
  WHERE restaurant_id = p_restaurant_id
    AND document_type = p_document_type
  RETURNING current_number INTO v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'Failed to reserve document number for restaurant % type %', p_restaurant_id, p_document_type;
  END IF;

  RETURN v_next;
END;
$$;

-- Set sequence so the *next* issued number equals p_start_at (never move backward).
CREATE OR REPLACE FUNCTION public.set_document_sequence_start(
  p_restaurant_id uuid,
  p_document_type text,
  p_start_at integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current integer;
  v_target integer;
BEGIN
  IF p_document_type NOT IN ('quote', 'invoice') THEN
    RAISE EXCEPTION 'Invalid document_type: %', p_document_type;
  END IF;

  IF p_start_at IS NULL OR p_start_at < 1 THEN
    RAISE EXCEPTION 'p_start_at must be a positive integer';
  END IF;

  v_target := p_start_at - 1;

  INSERT INTO public.document_sequences (restaurant_id, document_type, current_number)
  VALUES (p_restaurant_id, p_document_type, v_target)
  ON CONFLICT (restaurant_id, document_type) DO NOTHING;

  SELECT current_number
  INTO v_current
  FROM public.document_sequences
  WHERE restaurant_id = p_restaurant_id
    AND document_type = p_document_type
  FOR UPDATE;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'Document sequence row missing for restaurant % type %', p_restaurant_id, p_document_type;
  END IF;

  IF p_start_at <= v_current THEN
    RAISE EXCEPTION
      'Cannot set document sequence backward: requested start % but current counter is %',
      p_start_at,
      v_current;
  END IF;

  UPDATE public.document_sequences
  SET current_number = v_target
  WHERE restaurant_id = p_restaurant_id
    AND document_type = p_document_type;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_next_document_number(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_document_sequence_start(uuid, text, integer) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. business_documents (snapshotted quotes / invoices)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.business_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  document_type text NOT NULL,
  document_number text NOT NULL,
  quote_id uuid REFERENCES public.business_documents(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  due_date timestamptz,
  reference_note text,
  business_name text,
  registration_number text,
  vat_number text,
  address text,
  phone text,
  logo_url text,
  bank_name text,
  bank_account_name text,
  bank_account_number text,
  bank_branch_code text,
  ship_to jsonb NOT NULL,
  bill_to jsonb NOT NULL,
  line_items jsonb NOT NULL,
  subtotal numeric NOT NULL,
  vat_amount numeric NOT NULL,
  total numeric NOT NULL,
  balance numeric NOT NULL,
  currency text NOT NULL DEFAULT 'NAD',
  created_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_documents_document_type_check CHECK (document_type IN ('quote', 'invoice')),
  CONSTRAINT business_documents_restaurant_document_type_number_key UNIQUE (restaurant_id, document_type, document_number)
);

CREATE INDEX IF NOT EXISTS business_documents_restaurant_id_idx
  ON public.business_documents (restaurant_id);

CREATE INDEX IF NOT EXISTS business_documents_restaurant_id_document_type_idx
  ON public.business_documents (restaurant_id, document_type);

CREATE INDEX IF NOT EXISTS business_documents_quote_id_idx
  ON public.business_documents (quote_id)
  WHERE quote_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. documents:read / documents:write on owner / manager roles
-- ---------------------------------------------------------------------------
UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'documents:read')
WHERE role_slug IN ('owner', 'manager')
  AND NOT ('documents:read' = ANY (permissions));

UPDATE public.restaurant_roles
SET permissions = array_append(permissions, 'documents:write')
WHERE role_slug IN ('owner', 'manager')
  AND NOT ('documents:write' = ANY (permissions));

-- ---------------------------------------------------------------------------
-- 5. RLS (read: documents:read or owner/manager on sensitive tables; write: documents:write)
-- ---------------------------------------------------------------------------
ALTER TABLE public.restaurant_billing_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_documents ENABLE ROW LEVEL SECURITY;

-- restaurant_billing_profiles
CREATE POLICY "Authorized staff can read restaurant billing profiles"
  ON public.restaurant_billing_profiles
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.restaurant_users ru
      WHERE ru.user_id = auth.uid()
        AND ru.restaurant_id = restaurant_billing_profiles.restaurant_id
        AND (
          ru.role IN ('owner', 'manager')
          OR EXISTS (
            SELECT 1
            FROM public.restaurant_roles rr
            WHERE rr.restaurant_id = ru.restaurant_id
              AND rr.role_slug = ru.role
              AND 'documents:read' = ANY (rr.permissions)
          )
        )
    )
  );

CREATE POLICY "Authorized staff can write restaurant billing profiles"
  ON public.restaurant_billing_profiles
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.restaurant_users ru
      WHERE ru.user_id = auth.uid()
        AND ru.restaurant_id = restaurant_billing_profiles.restaurant_id
        AND (
          ru.role IN ('owner', 'manager')
          OR EXISTS (
            SELECT 1
            FROM public.restaurant_roles rr
            WHERE rr.restaurant_id = ru.restaurant_id
              AND rr.role_slug = ru.role
              AND 'documents:write' = ANY (rr.permissions)
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.restaurant_users ru
      WHERE ru.user_id = auth.uid()
        AND ru.restaurant_id = restaurant_billing_profiles.restaurant_id
        AND (
          ru.role IN ('owner', 'manager')
          OR EXISTS (
            SELECT 1
            FROM public.restaurant_roles rr
            WHERE rr.restaurant_id = ru.restaurant_id
              AND rr.role_slug = ru.role
              AND 'documents:write' = ANY (rr.permissions)
          )
        )
    )
  );

-- document_sequences
CREATE POLICY "Staff can read document sequences"
  ON public.document_sequences
  FOR SELECT
  USING (restaurant_id IN (SELECT public.user_restaurant_ids()));

CREATE POLICY "Authorized staff can write document sequences"
  ON public.document_sequences
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.restaurant_users ru
      WHERE ru.user_id = auth.uid()
        AND ru.restaurant_id = document_sequences.restaurant_id
        AND (
          ru.role IN ('owner', 'manager')
          OR EXISTS (
            SELECT 1
            FROM public.restaurant_roles rr
            WHERE rr.restaurant_id = ru.restaurant_id
              AND rr.role_slug = ru.role
              AND 'documents:write' = ANY (rr.permissions)
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.restaurant_users ru
      WHERE ru.user_id = auth.uid()
        AND ru.restaurant_id = document_sequences.restaurant_id
        AND (
          ru.role IN ('owner', 'manager')
          OR EXISTS (
            SELECT 1
            FROM public.restaurant_roles rr
            WHERE rr.restaurant_id = ru.restaurant_id
              AND rr.role_slug = ru.role
              AND 'documents:write' = ANY (rr.permissions)
          )
        )
    )
  );

-- business_documents
CREATE POLICY "Authorized staff can read business documents"
  ON public.business_documents
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.restaurant_users ru
      WHERE ru.user_id = auth.uid()
        AND ru.restaurant_id = business_documents.restaurant_id
        AND (
          ru.role IN ('owner', 'manager')
          OR EXISTS (
            SELECT 1
            FROM public.restaurant_roles rr
            WHERE rr.restaurant_id = ru.restaurant_id
              AND rr.role_slug = ru.role
              AND 'documents:read' = ANY (rr.permissions)
          )
        )
    )
  );

CREATE POLICY "Authorized staff can write business documents"
  ON public.business_documents
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
      FROM public.restaurant_users ru
      WHERE ru.user_id = auth.uid()
        AND ru.restaurant_id = business_documents.restaurant_id
        AND (
          ru.role IN ('owner', 'manager')
          OR EXISTS (
            SELECT 1
            FROM public.restaurant_roles rr
            WHERE rr.restaurant_id = ru.restaurant_id
              AND rr.role_slug = ru.role
              AND 'documents:write' = ANY (rr.permissions)
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.restaurant_users ru
      WHERE ru.user_id = auth.uid()
        AND ru.restaurant_id = business_documents.restaurant_id
        AND (
          ru.role IN ('owner', 'manager')
          OR EXISTS (
            SELECT 1
            FROM public.restaurant_roles rr
            WHERE rr.restaurant_id = ru.restaurant_id
              AND rr.role_slug = ru.role
              AND 'documents:write' = ANY (rr.permissions)
          )
        )
    )
  );
