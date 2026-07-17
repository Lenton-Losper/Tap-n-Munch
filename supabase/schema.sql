--
-- PostgreSQL database dump
--

-- \restrict 58h7FxN5fqmM5IG7wtG1yfBn3iEROmOwELFL64fnDl1gtCnPq9mT2eq74rMcLdE

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
-- SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: pg_database_owner
--

CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";

--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: pg_database_owner
--

COMMENT ON SCHEMA "public" IS 'standard public schema';


--
-- Name: assign_grv_number(); Type: FUNCTION; Schema: public; Owner: postgres
--

-- Delegates to generate_document_number() (see receipt_documents below) instead of
-- reimplementing the prefix + LPAD(nextval(...)) logic inline -- one numbering
-- mechanism, not two. grv_number_seq is unchanged (supabase/migrations/20260717150000).
CREATE OR REPLACE FUNCTION "public"."assign_grv_number"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    IF NEW.grv_number IS NULL THEN
        NEW.grv_number := public.generate_document_number('GRV', 'grv_number_seq');
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."assign_grv_number"() OWNER TO "postgres";

--
-- Name: close_table_session("uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."close_table_session"("p_table_id" "uuid", "p_restaurant_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_tabs_settled INTEGER;
  v_sessions_expired INTEGER;
  v_new_version INTEGER;
BEGIN
  -- Step 1: Settle all active tabs for this table
  UPDATE tabs
  SET 
    status = 'settled',
    settled_at = now(),
    settled_type = 'manual_close'
  WHERE 
    table_id = p_table_id
    AND restaurant_id = p_restaurant_id
    AND status IN ('open', 'ready_to_pay', 'active');

  GET DIAGNOSTICS v_tabs_settled = ROW_COUNT;

  -- Step 2: Expire all customer sessions linked to those tabs
  UPDATE customer_sessions
  SET 
    active = false,
    expires_at = now()
  WHERE tab_id IN (
    SELECT id FROM tabs 
    WHERE table_id = p_table_id
    AND restaurant_id = p_restaurant_id
  );

  GET DIAGNOSTICS v_sessions_expired = ROW_COUNT;

  -- Step 3: Increment session version and mark table available
  UPDATE restaurant_tables
  SET
    current_session_version = current_session_version + 1,
    status = 'available'
  WHERE id = p_table_id;

  -- Get new version for response
  SELECT current_session_version INTO v_new_version
  FROM restaurant_tables
  WHERE id = p_table_id;

  -- Return summary
  RETURN jsonb_build_object(
    'success', true,
    'tabs_settled', v_tabs_settled,
    'sessions_expired', v_sessions_expired,
    'new_session_version', v_new_version
  );

EXCEPTION WHEN OTHERS THEN
  -- Any error rolls back everything
  RAISE;
END;
$$;


ALTER FUNCTION "public"."close_table_session"("p_table_id" "uuid", "p_restaurant_id" "uuid") OWNER TO "postgres";

--
-- Name: create_movement_from_goods_received_item(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."create_movement_from_goods_received_item"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_restaurant_id uuid;
    v_received_by uuid;
    v_received_at timestamptz;
BEGIN
    SELECT restaurant_id, received_by, received_at
    INTO v_restaurant_id, v_received_by, v_received_at
    FROM "public"."goods_received"
    WHERE id = NEW.goods_received_id;

    INSERT INTO "public"."stock_movements" (
        restaurant_id, stock_item_id, quantity_delta, reason,
        reference_type, reference_id, created_by, created_at
    ) VALUES (
        v_restaurant_id, NEW.stock_item_id, NEW.quantity, 'received',
        'goods_received_items', NEW.id, v_received_by, v_received_at
    );
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."create_movement_from_goods_received_item"() OWNER TO "postgres";

--
-- Name: deduct_recipe_stock(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."deduct_recipe_stock"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $
DECLARE
    v_order record;
    v_line_item jsonb;
    v_menu_item_id uuid;
    v_line_qty numeric;
    v_recipe_id uuid;
    v_recipe_item record;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "public"."stock_movements"
        WHERE reference_type = 'order'
          AND reference_id = p_order_id
    ) THEN
        RETURN;
    END IF;

    SELECT id, restaurant_id, items
    INTO v_order
    FROM "public"."orders"
    WHERE id = p_order_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF v_order.items IS NULL OR jsonb_typeof(v_order.items) <> 'array' THEN
        RETURN;
    END IF;

    FOR v_line_item IN
        SELECT value FROM jsonb_array_elements(v_order.items)
    LOOP
        BEGIN
            v_menu_item_id := COALESCE(
                (v_line_item->>'menu_item_id')::uuid,
                (v_line_item->>'menuItemId')::uuid
            );
            v_line_qty := COALESCE((v_line_item->>'quantity')::numeric, 1);

            IF v_menu_item_id IS NULL OR v_line_qty <= 0 THEN
                CONTINUE;
            END IF;

            SELECT id
            INTO v_recipe_id
            FROM "public"."recipes"
            WHERE restaurant_id = v_order.restaurant_id
              AND menu_item_id = v_menu_item_id
              AND is_active = true
            LIMIT 1;

            IF v_recipe_id IS NULL THEN
                CONTINUE;
            END IF;

            FOR v_recipe_item IN
                SELECT stock_item_id, quantity
                FROM "public"."recipe_items"
                WHERE recipe_id = v_recipe_id
            LOOP
                INSERT INTO "public"."stock_movements" (
                    restaurant_id, stock_item_id, quantity_delta, reason,
                    reference_type, reference_id, created_by, created_at
                ) VALUES (
                    v_order.restaurant_id,
                    v_recipe_item.stock_item_id,
                    -(v_recipe_item.quantity * v_line_qty),
                    'sale',
                    'order',
                    p_order_id,
                    NULL,
                    now()
                );
            END LOOP;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE WARNING 'deduct_recipe_stock line item error for order %: %', p_order_id, SQLERRM;
        END;
    END LOOP;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'deduct_recipe_stock error for order %: %', p_order_id, SQLERRM;
END;
$;


ALTER FUNCTION "public"."deduct_recipe_stock"("p_order_id" "uuid") OWNER TO "postgres";

--
-- Name: trg_order_completion_deducts_stock(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."trg_order_completion_deducts_stock"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $
BEGIN
    PERFORM "public"."deduct_recipe_stock"(NEW.id);
    RETURN NEW;
END;
$;


ALTER FUNCTION "public"."trg_order_completion_deducts_stock"() OWNER TO "postgres";



--
-- Name: increment_settings_version(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."increment_settings_version"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.settings_version = OLD.settings_version + 1;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."increment_settings_version"() OWNER TO "postgres";

--
-- Name: notify_kitchen_on_new_order(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."notify_kitchen_on_new_order"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
  PERFORM
    net.http_post(
      url := 'https://ihlmmpmolnpchzgwyhgh.supabase.co/functions/v1/notify-kitchen',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlobG1tcG1vbG5wY2h6Z3d5aGdoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njg3NDcwMCwiZXhwIjoyMDkyNDUwNzAwfQ.38MbKVjkBFTNpqgcJVGzXVFpWHRFPsC8dKHvKTF0v3E'
      ),
      body := jsonb_build_object('record', row_to_json(NEW))
    );
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."notify_kitchen_on_new_order"() OWNER TO "postgres";

--
-- Name: user_restaurant_ids(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."user_restaurant_ids"() RETURNS SETOF "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
    SELECT restaurant_id FROM restaurant_users WHERE user_id = auth.uid();
$$;


ALTER FUNCTION "public"."user_restaurant_ids"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "entity_type" "text",
    "entity_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."audit_logs" OWNER TO "postgres";

--
-- Name: bug_reports; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."bug_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid",
    "description" "text" NOT NULL,
    "area" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."bug_reports" OWNER TO "postgres";

--
-- Name: customer_sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."customer_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "token" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tab_id" "uuid",
    "table_id" "uuid",
    "restaurant_id" "uuid",
    "session_version" integer NOT NULL,
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "last_seen_at" timestamp with time zone DEFAULT "now"(),
    "expires_at" timestamp with time zone DEFAULT ("now"() + '24:00:00'::interval)
);


ALTER TABLE "public"."customer_sessions" OWNER TO "postgres";

--
-- Name: daily_analytics; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."daily_analytics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid",
    "date" "date" NOT NULL,
    "total_orders" integer DEFAULT 0,
    "total_revenue" numeric DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "firebase_restaurant_id" "text"
);


ALTER TABLE "public"."daily_analytics" OWNER TO "postgres";

--
-- Name: goods_received; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."goods_received" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "supplier" "text",
    "invoice_number" "text",
    "received_by" "uuid",
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "grv_number" "text"
);


ALTER TABLE "public"."goods_received" OWNER TO "postgres";

--
-- Name: goods_received_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."goods_received_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "goods_received_id" "uuid" NOT NULL,
    "stock_item_id" "uuid" NOT NULL,
    "quantity" numeric NOT NULL,
    "unit_cost" numeric,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "goods_received_items_quantity_check" CHECK (("quantity" > (0)::numeric))
);


ALTER TABLE "public"."goods_received_items" OWNER TO "postgres";

--
-- Name: grv_number_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE IF NOT EXISTS "public"."grv_number_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."grv_number_seq" OWNER TO "postgres";

--
-- Name: inventory_movements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."inventory_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "menu_item_id" "uuid" NOT NULL,
    "change_amount" integer NOT NULL,
    "reason" "text" NOT NULL,
    "reference_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "inventory_movements_reason_check" CHECK (("reason" = ANY (ARRAY['order'::"text", 'restock'::"text", 'cancellation'::"text", 'manual_adjustment'::"text"])))
);


ALTER TABLE "public"."inventory_movements" OWNER TO "postgres";

--
-- Name: menu_categories; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."menu_categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "display_order" integer DEFAULT 0,
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "firebase_restaurant_id" "text",
    "route_to" "text" DEFAULT 'kitchen'::"text" NOT NULL,
    CONSTRAINT "menu_categories_route_to_check" CHECK (("route_to" = ANY (ARRAY['kitchen'::"text", 'bar'::"text", 'both'::"text"])))
);


ALTER TABLE "public"."menu_categories" OWNER TO "postgres";

--
-- Name: menu_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."menu_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subcategory_id" "uuid",
    "category_id" "uuid",
    "restaurant_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "base_price" numeric DEFAULT 0 NOT NULL,
    "image_url" "text",
    "status" "text" DEFAULT 'active'::"text",
    "variants" "jsonb" DEFAULT '[]'::"jsonb",
    "variant_groups" "jsonb" DEFAULT '[]'::"jsonb",
    "times_ordered" integer DEFAULT 0,
    "total_revenue" numeric DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "firebase_restaurant_id" "text",
    "is_popular" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."menu_items" OWNER TO "postgres";

--
-- Name: menu_subcategories; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."menu_subcategories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "category_id" "uuid",
    "restaurant_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "display_order" integer DEFAULT 0,
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "firebase_restaurant_id" "text"
);


ALTER TABLE "public"."menu_subcategories" OWNER TO "postgres";

--
-- Name: orders; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid",
    "table_id" "uuid",
    "tab_id" "uuid",
    "order_number" integer,
    "table_number" integer,
    "session_id" "text",
    "member_session_id" "text",
    "status" "text" DEFAULT 'new'::"text",
    "payment_status" "text" DEFAULT 'pending'::"text",
    "payment_method" "text" DEFAULT 'cash'::"text",
    "payment_channel" "text",
    "subtotal" numeric DEFAULT 0,
    "tax" numeric DEFAULT 0,
    "total" numeric DEFAULT 0,
    "items" "jsonb" DEFAULT '[]'::"jsonb",
    "order_instructions" "text",
    "is_closed" boolean DEFAULT false,
    "table_closed" boolean DEFAULT false,
    "tab_settlement_for_tab_id" "text",
    "paycloud_merchant_order_no" "text",
    "payment_checkout_url" "text",
    "terminal_sn" "text",
    "placed_at" timestamp with time zone DEFAULT "now"(),
    "accepted_at" timestamp with time zone,
    "preparing_at" timestamp with time zone,
    "ready_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "paid_at" timestamp with time zone,
    "firebase_restaurant_id" "text",
    "firebase_id" "text",
    "idempotency_key" "text",
    "payment_provider" "text",
    "payment_reference" "text",
    "customer_ready_to_pay" boolean DEFAULT false,
    "channel" "text" DEFAULT 'table'::"text" NOT NULL,
    "kiosk_order_number" integer,
    "customer_name" "text",
    CONSTRAINT "valid_order_channel" CHECK (("channel" = ANY (ARRAY['table'::"text", 'kiosk'::"text", 'pos'::"text", 'online'::"text", 'delivery'::"text"])))
);


ALTER TABLE "public"."orders" OWNER TO "postgres";

--
-- Name: payments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid",
    "table_id" "uuid",
    "tab_id" "uuid",
    "order_ids" "uuid"[] DEFAULT '{}'::"uuid"[],
    "amount" numeric DEFAULT 0 NOT NULL,
    "method" "text" DEFAULT 'card'::"text",
    "status" "text" DEFAULT 'pending'::"text",
    "gateway_reference" "text",
    "payment_reference" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "completed_at" timestamp with time zone
);


ALTER TABLE "public"."payments" OWNER TO "postgres";

--
-- Name: platform_admins; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."platform_admins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "email" "text" NOT NULL,
    "role" "text" DEFAULT 'support'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "platform_admins_role_check" CHECK (("role" = ANY (ARRAY['super_admin'::"text", 'support'::"text"])))
);


ALTER TABLE "public"."platform_admins" OWNER TO "postgres";

--
-- Name: platform_audit_logs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."platform_audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_id" "uuid",
    "actor_email" "text" NOT NULL,
    "action" "text" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "uuid",
    "payload" "jsonb",
    "ip_address" "text",
    "user_agent" "text",
    "success" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."platform_audit_logs" OWNER TO "postgres";

--
-- Name: restaurant_settings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."restaurant_settings" (
    "restaurant_id" "uuid" NOT NULL,
    "payment_methods" "text"[] DEFAULT ARRAY['cash'::"text", 'card'::"text"] NOT NULL,
    "tab_pin_required" boolean DEFAULT true NOT NULL,
    "max_tab_hours" integer DEFAULT 8 NOT NULL,
    "allow_split_bill" boolean DEFAULT false NOT NULL,
    "currency" "text" DEFAULT 'NAD'::"text" NOT NULL,
    "timezone" "text" DEFAULT 'Africa/Windhoek'::"text" NOT NULL,
    "tax_rate" numeric(5,2) DEFAULT 0 NOT NULL,
    "service_charge" numeric(5,2) DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "settings_version" integer DEFAULT 1 NOT NULL,
    "kiosk_payment_methods" "text"[] DEFAULT ARRAY['cash'::"text", 'card'::"text", 'other'::"text"] NOT NULL,
    CONSTRAINT "payment_methods_valid_values" CHECK (("payment_methods" <@ ARRAY['cash'::"text", 'card'::"text", 'hosted_checkout'::"text", 'eft'::"text", 'voucher'::"text", 'mobile_money'::"text"])),
    CONSTRAINT "valid_kiosk_payment_methods" CHECK (("kiosk_payment_methods" <@ ARRAY['cash'::"text", 'card'::"text", 'other'::"text"]))
);


ALTER TABLE "public"."restaurant_settings" OWNER TO "postgres";

--
-- Name: public_restaurant_settings; Type: VIEW; Schema: public; Owner: postgres
--

CREATE OR REPLACE VIEW "public"."public_restaurant_settings" AS
 SELECT "restaurant_id",
    "currency",
    "payment_methods",
    "kiosk_payment_methods",
    "tab_pin_required",
    "max_tab_hours"
   FROM "public"."restaurant_settings";


ALTER VIEW "public"."public_restaurant_settings" OWNER TO "postgres";

--
-- Name: report_schedules; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."report_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "email" "text" NOT NULL,
    "format" "text" DEFAULT 'pdf'::"text" NOT NULL,
    "send_time" time without time zone DEFAULT '20:00:00'::time without time zone NOT NULL,
    "timezone" "text" DEFAULT 'Africa/Windhoek'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_sent_at" timestamp with time zone,
    CONSTRAINT "report_schedules_format_check" CHECK (("format" = ANY (ARRAY['pdf'::"text", 'csv'::"text"])))
);


ALTER TABLE "public"."report_schedules" OWNER TO "postgres";

--
-- Name: report_send_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."report_send_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "schedule_id" "uuid" NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "report_period" "date" NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" NOT NULL,
    "error" "text",
    "duration_ms" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "report_send_log_status_check" CHECK (("status" = ANY (ARRAY['success'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."report_send_log" OWNER TO "postgres";

--
-- Name: restaurant_features; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."restaurant_features" (
    "restaurant_id" "uuid" NOT NULL,
    "kitchen_enabled" boolean DEFAULT false NOT NULL,
    "inventory_enabled" boolean DEFAULT false NOT NULL,
    "analytics_enabled" boolean DEFAULT false NOT NULL,
    "split_bill_enabled" boolean DEFAULT false NOT NULL,
    "reservations_enabled" boolean DEFAULT false NOT NULL,
    "loyalty_enabled" boolean DEFAULT false NOT NULL,
    "online_payments_enabled" boolean DEFAULT false NOT NULL,
    "multi_branch_enabled" boolean DEFAULT false NOT NULL,
    "staff_app_enabled" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "kiosk_enabled" boolean DEFAULT false NOT NULL,
    "whatsapp_enabled" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."restaurant_features" OWNER TO "postgres";

--
-- Name: restaurant_invites; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."restaurant_invites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" NOT NULL,
    "invited_by" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "restaurant_invites_role_check" CHECK (("role" = ANY (ARRAY['manager'::"text", 'waiter'::"text"])))
);


ALTER TABLE "public"."restaurant_invites" OWNER TO "postgres";

--
-- Name: restaurant_setup_status; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."restaurant_setup_status" (
    "restaurant_id" "uuid" NOT NULL,
    "profile_complete" boolean DEFAULT false NOT NULL,
    "tables_configured" boolean DEFAULT false NOT NULL,
    "menu_added" boolean DEFAULT false NOT NULL,
    "qr_downloaded" boolean DEFAULT false NOT NULL,
    "staff_added" boolean DEFAULT false NOT NULL,
    "terminal_connected" boolean DEFAULT false NOT NULL,
    "test_order_completed" boolean DEFAULT false NOT NULL,
    "first_payment_completed" boolean DEFAULT false NOT NULL,
    "completion_percentage" integer DEFAULT 0,
    "profile_completed_at" timestamp with time zone,
    "tables_configured_at" timestamp with time zone,
    "menu_added_at" timestamp with time zone,
    "qr_downloaded_at" timestamp with time zone,
    "staff_added_at" timestamp with time zone,
    "terminal_connected_at" timestamp with time zone,
    "test_order_completed_at" timestamp with time zone,
    "first_payment_completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "dismissed" boolean DEFAULT false
);


ALTER TABLE "public"."restaurant_setup_status" OWNER TO "postgres";

--
-- Name: restaurant_tables; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."restaurant_tables" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid",
    "table_number" integer NOT NULL,
    "table_name" "text",
    "qr_code_url" "text",
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "firebase_restaurant_id" "text",
    "current_session_version" integer DEFAULT 1,
    "status" "text" DEFAULT 'available'::"text",
    "is_kiosk" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."restaurant_tables" OWNER TO "postgres";

--
-- Name: restaurant_terminals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."restaurant_terminals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "device_id" "text",
    "sn" "text",
    "name" "text",
    "model" "text",
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "last_seen_at" timestamp with time zone DEFAULT "now"(),
    "activation_code" "text",
    "activation_code_expires_at" timestamp with time zone,
    "activated_at" timestamp with time zone,
    "device_serial" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "app_version" "text",
    "terminal_name" "text",
    "refresh_token_hash" "text",
    "refresh_token_expires_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    CONSTRAINT "restaurant_terminals_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'inactive'::"text", 'revoked'::"text", 'pending'::"text"])))
);


ALTER TABLE "public"."restaurant_terminals" OWNER TO "postgres";

--
-- Name: restaurant_users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."restaurant_users" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "invited_by" "uuid",
    "invite_accepted" boolean DEFAULT true,
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "restaurant_users_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'cashier'::"text", 'waiter'::"text", 'kitchen'::"text"])))
);


ALTER TABLE "public"."restaurant_users" OWNER TO "postgres";

--
-- Name: restaurants; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."restaurants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "owner_id" "uuid",
    "name" "text" NOT NULL,
    "slug" "text",
    "phone" "text",
    "logo_url" "text",
    "primary_color" "text" DEFAULT '#FF6B35'::"text",
    "currency" "text" DEFAULT 'NAD'::"text",
    "tax_rate" numeric DEFAULT 0,
    "service_fee" numeric DEFAULT 0,
    "payment_methods" "text"[] DEFAULT ARRAY['cash'::"text"],
    "subscription_status" "text" DEFAULT 'trial'::"text",
    "subscription_tier" "text" DEFAULT 'starter'::"text",
    "finatic_merchant_no" "text",
    "finatic_store_no" "text",
    "finatic_terminal_sn" "text",
    "terminals" "jsonb" DEFAULT '[]'::"jsonb",
    "online_ordering_enabled" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "firebase_id" "text",
    "checkout_merchant_no" "text",
    "checkout_store_no" "text",
    "address" "text",
    "subdomain" "text",
    "timezone" "text" DEFAULT 'Africa/Windhoek'::"text",
    "is_active" boolean DEFAULT false,
    "activated_at" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "created_by" "uuid",
    "tab_pin_required" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."restaurants" OWNER TO "postgres";

--
-- Name: staff_invites; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."staff_invites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "invited_by" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" NOT NULL,
    "token" "uuid" DEFAULT "gen_random_uuid"(),
    "accepted" boolean DEFAULT false,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval),
    "accepted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "staff_invites_role_check" CHECK (("role" = ANY (ARRAY['manager'::"text", 'cashier'::"text", 'waiter'::"text", 'kitchen'::"text"])))
);


ALTER TABLE "public"."staff_invites" OWNER TO "postgres";

--
-- Name: staff_members; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."staff_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid",
    "email" "text",
    "role" "text",
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "push_token" "text",
    CONSTRAINT "staff_members_role_check" CHECK (("role" = ANY (ARRAY['manager'::"text", 'cashier'::"text", 'waiter'::"text", 'kitchen'::"text"])))
);


ALTER TABLE "public"."staff_members" OWNER TO "postgres";

--
-- Name: staff_permissions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."staff_permissions" (
    "staff_id" "uuid" NOT NULL,
    "permission" "text" NOT NULL,
    "effect" "text" DEFAULT 'allow'::"text" NOT NULL,
    "restaurant_id" "uuid",
    CONSTRAINT "staff_permissions_effect_check" CHECK (("effect" = ANY (ARRAY['allow'::"text", 'deny'::"text"])))
);


ALTER TABLE "public"."staff_permissions" OWNER TO "postgres";

--
-- Name: stock_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."stock_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "unit_id" "uuid" NOT NULL,
    "is_purchasable" boolean DEFAULT true NOT NULL,
    "is_manufactured" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "purchase_unit" "text",
    "conversion_factor" numeric,
    "par_level" numeric
);


ALTER TABLE "public"."stock_items" OWNER TO "postgres";

--
-- Name: stock_movements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."stock_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "stock_item_id" "uuid" NOT NULL,
    "quantity_delta" numeric NOT NULL,
    "reason" "text" NOT NULL,
    "reference_type" "text",
    "reference_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text",
    "adjustment_type" "text",
    CONSTRAINT "adjustment_type_requires_adjustment_reason" CHECK ((("adjustment_type" IS NULL) OR ("reason" = 'adjustment'::"text"))),
    CONSTRAINT "stock_movements_reason_check" CHECK (("reason" = ANY (ARRAY['received'::"text", 'adjustment'::"text", 'loss'::"text", 'theft'::"text", 'recount'::"text", 'sale'::"text"]))),
    CONSTRAINT "valid_adjustment_type" CHECK ((("adjustment_type" IS NULL) OR ("adjustment_type" = ANY (ARRAY['sale'::"text", 'waste'::"text", 'damage'::"text", 'count'::"text", 'other'::"text"]))))
);


ALTER TABLE "public"."stock_movements" OWNER TO "postgres";

--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "plan" "text" DEFAULT 'starter'::"text" NOT NULL,
    "status" "text" DEFAULT 'trial'::"text" NOT NULL,
    "price" numeric(10,2) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'NAD'::"text" NOT NULL,
    "trial_ends_at" timestamp with time zone,
    "renews_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "subscriptions_plan_check" CHECK (("plan" = ANY (ARRAY['starter'::"text", 'professional'::"text", 'enterprise'::"text"]))),
    CONSTRAINT "subscriptions_status_check" CHECK (("status" = ANY (ARRAY['trial'::"text", 'active'::"text", 'past_due'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."subscriptions" OWNER TO "postgres";

--
-- Name: table_assignments; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."table_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_user_id" "uuid" NOT NULL,
    "table_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."table_assignments" OWNER TO "postgres";

--
-- Name: table_sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."table_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "table_id" "uuid",
    "restaurant_id" "uuid",
    "status" "text" DEFAULT 'active'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "closed_at" timestamp with time zone
);


ALTER TABLE "public"."table_sessions" OWNER TO "postgres";

--
-- Name: tabs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."tabs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid",
    "table_id" "uuid",
    "table_number" integer,
    "status" "text" DEFAULT 'open'::"text",
    "members" "jsonb" DEFAULT '[]'::"jsonb",
    "total" numeric DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "settled_at" timestamp with time zone,
    "firebase_restaurant_id" "text",
    "firebase_id" "text",
    "settled_type" "text",
    "session_token" "uuid",
    "session_version" integer,
    "payment_preference" "text",
    "ready_to_pay_at" timestamp with time zone,
    "tab_pin" character varying(4),
    "pin_required" boolean DEFAULT true NOT NULL,
    "customer_name" "text",
    CONSTRAINT "tab_pin_format" CHECK ((("tab_pin")::"text" ~ '^[0-9]{4}$'::"text"))
);


ALTER TABLE "public"."tabs" OWNER TO "postgres";

--
-- Name: terminal_activation_codes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."terminal_activation_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "terminal_id" "uuid" NOT NULL,
    "code" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."terminal_activation_codes" OWNER TO "postgres";

--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."users" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "name" "text",
    "phone" "text",
    "role" "text" DEFAULT 'owner'::"text",
    "restaurant_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "last_login" timestamp with time zone,
    "firebase_uid" "text",
    "full_name" "text",
    "avatar_url" "text",
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."users" OWNER TO "postgres";

--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");


--
-- Name: bug_reports bug_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."bug_reports"
    ADD CONSTRAINT "bug_reports_pkey" PRIMARY KEY ("id");


--
-- Name: customer_sessions customer_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."customer_sessions"
    ADD CONSTRAINT "customer_sessions_pkey" PRIMARY KEY ("id");


--
-- Name: customer_sessions customer_sessions_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."customer_sessions"
    ADD CONSTRAINT "customer_sessions_token_key" UNIQUE ("token");


--
-- Name: daily_analytics daily_analytics_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."daily_analytics"
    ADD CONSTRAINT "daily_analytics_pkey" PRIMARY KEY ("id");


--
-- Name: daily_analytics daily_analytics_restaurant_id_date_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."daily_analytics"
    ADD CONSTRAINT "daily_analytics_restaurant_id_date_key" UNIQUE ("restaurant_id", "date");


--
-- Name: goods_received_items goods_received_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."goods_received_items"
    ADD CONSTRAINT "goods_received_items_pkey" PRIMARY KEY ("id");


--
-- Name: goods_received goods_received_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."goods_received"
    ADD CONSTRAINT "goods_received_pkey" PRIMARY KEY ("id");


--
-- Name: inventory_movements inventory_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id");


--
-- Name: menu_categories menu_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."menu_categories"
    ADD CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id");


--
-- Name: menu_items menu_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id");


--
-- Name: menu_subcategories menu_subcategories_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."menu_subcategories"
    ADD CONSTRAINT "menu_subcategories_pkey" PRIMARY KEY ("id");


--
-- Name: orders orders_firebase_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_firebase_id_key" UNIQUE ("firebase_id");


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");


--
-- Name: platform_admins platform_admins_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_email_key" UNIQUE ("email");


--
-- Name: platform_admins platform_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id");


--
-- Name: platform_audit_logs platform_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."platform_audit_logs"
    ADD CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id");


--
-- Name: report_schedules report_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."report_schedules"
    ADD CONSTRAINT "report_schedules_pkey" PRIMARY KEY ("id");


--
-- Name: report_send_log report_send_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."report_send_log"
    ADD CONSTRAINT "report_send_log_pkey" PRIMARY KEY ("id");


--
-- Name: restaurant_features restaurant_features_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_features"
    ADD CONSTRAINT "restaurant_features_pkey" PRIMARY KEY ("restaurant_id");


--
-- Name: restaurant_invites restaurant_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_invites"
    ADD CONSTRAINT "restaurant_invites_pkey" PRIMARY KEY ("id");


--
-- Name: restaurant_settings restaurant_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_settings"
    ADD CONSTRAINT "restaurant_settings_pkey" PRIMARY KEY ("restaurant_id");


--
-- Name: restaurant_setup_status restaurant_setup_status_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_setup_status"
    ADD CONSTRAINT "restaurant_setup_status_pkey" PRIMARY KEY ("restaurant_id");


--
-- Name: restaurant_tables restaurant_tables_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_tables"
    ADD CONSTRAINT "restaurant_tables_pkey" PRIMARY KEY ("id");


--
-- Name: restaurant_terminals restaurant_terminals_device_id_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_terminals"
    ADD CONSTRAINT "restaurant_terminals_device_id_unique" UNIQUE ("device_id");


--
-- Name: restaurant_terminals restaurant_terminals_device_serial_unique; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_terminals"
    ADD CONSTRAINT "restaurant_terminals_device_serial_unique" UNIQUE ("device_serial");


--
-- Name: restaurant_terminals restaurant_terminals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_terminals"
    ADD CONSTRAINT "restaurant_terminals_pkey" PRIMARY KEY ("id");


--
-- Name: restaurant_users restaurant_users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_users"
    ADD CONSTRAINT "restaurant_users_pkey" PRIMARY KEY ("id");


--
-- Name: restaurant_users restaurant_users_restaurant_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_users"
    ADD CONSTRAINT "restaurant_users_restaurant_id_user_id_key" UNIQUE ("restaurant_id", "user_id");


--
-- Name: restaurants restaurants_firebase_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_firebase_id_key" UNIQUE ("firebase_id");


--
-- Name: restaurants restaurants_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_pkey" PRIMARY KEY ("id");


--
-- Name: restaurants restaurants_slug_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_slug_key" UNIQUE ("slug");


--
-- Name: restaurants restaurants_subdomain_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_subdomain_key" UNIQUE ("subdomain");


--
-- Name: staff_invites staff_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_invites"
    ADD CONSTRAINT "staff_invites_pkey" PRIMARY KEY ("id");


--
-- Name: staff_invites staff_invites_restaurant_id_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_invites"
    ADD CONSTRAINT "staff_invites_restaurant_id_email_key" UNIQUE ("restaurant_id", "email");


--
-- Name: staff_members staff_members_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_members"
    ADD CONSTRAINT "staff_members_pkey" PRIMARY KEY ("id");


--
-- Name: staff_permissions staff_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_permissions"
    ADD CONSTRAINT "staff_permissions_pkey" PRIMARY KEY ("staff_id", "permission");


--
-- Name: stock_items stock_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."stock_items"
    ADD CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id");


--
-- Name: stock_movements stock_movements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id");


--
-- Name: subscriptions subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");


--
-- Name: table_assignments table_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."table_assignments"
    ADD CONSTRAINT "table_assignments_pkey" PRIMARY KEY ("id");


--
-- Name: table_assignments table_assignments_restaurant_user_id_table_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."table_assignments"
    ADD CONSTRAINT "table_assignments_restaurant_user_id_table_id_key" UNIQUE ("restaurant_user_id", "table_id");


--
-- Name: table_sessions table_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."table_sessions"
    ADD CONSTRAINT "table_sessions_pkey" PRIMARY KEY ("id");


--
-- Name: tabs tabs_firebase_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."tabs"
    ADD CONSTRAINT "tabs_firebase_id_key" UNIQUE ("firebase_id");


--
-- Name: tabs tabs_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."tabs"
    ADD CONSTRAINT "tabs_pkey" PRIMARY KEY ("id");


--
-- Name: terminal_activation_codes terminal_activation_codes_code_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."terminal_activation_codes"
    ADD CONSTRAINT "terminal_activation_codes_code_key" UNIQUE ("code");


--
-- Name: terminal_activation_codes terminal_activation_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."terminal_activation_codes"
    ADD CONSTRAINT "terminal_activation_codes_pkey" PRIMARY KEY ("id");


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_email_key" UNIQUE ("email");


--
-- Name: users users_firebase_uid_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_firebase_uid_key" UNIQUE ("firebase_uid");


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");


--
-- Name: audit_logs_restaurant_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "audit_logs_restaurant_id_idx" ON "public"."audit_logs" USING "btree" ("restaurant_id");


--
-- Name: bug_reports_created_at_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "bug_reports_created_at_idx" ON "public"."bug_reports" USING "btree" ("created_at" DESC);


--
-- Name: bug_reports_restaurant_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "bug_reports_restaurant_id_idx" ON "public"."bug_reports" USING "btree" ("restaurant_id");


--
-- Name: idx_customer_sessions_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_customer_sessions_active" ON "public"."customer_sessions" USING "btree" ("active");


--
-- Name: idx_customer_sessions_tab_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_customer_sessions_tab_id" ON "public"."customer_sessions" USING "btree" ("tab_id");


--
-- Name: idx_customer_sessions_token; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "idx_customer_sessions_token" ON "public"."customer_sessions" USING "btree" ("token");


--
-- Name: idx_goods_received_grv_number; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "idx_goods_received_grv_number" ON "public"."goods_received" USING "btree" ("grv_number");


--
-- Name: idx_goods_received_invoice; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_goods_received_invoice" ON "public"."goods_received" USING "btree" ("invoice_number");


--
-- Name: idx_goods_received_items_grv; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_goods_received_items_grv" ON "public"."goods_received_items" USING "btree" ("goods_received_id");


--
-- Name: idx_goods_received_items_stock_item; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_goods_received_items_stock_item" ON "public"."goods_received_items" USING "btree" ("stock_item_id");


--
-- Name: idx_goods_received_restaurant; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_goods_received_restaurant" ON "public"."goods_received" USING "btree" ("restaurant_id");


--
-- Name: idx_orders_channel; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_orders_channel" ON "public"."orders" USING "btree" ("channel");


--
-- Name: idx_orders_idempotency_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "idx_orders_idempotency_key" ON "public"."orders" USING "btree" ("idempotency_key") WHERE ("idempotency_key" IS NOT NULL);


--
-- Name: idx_orders_ready_to_pay; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_orders_ready_to_pay" ON "public"."orders" USING "btree" ("restaurant_id", "customer_ready_to_pay") WHERE ("customer_ready_to_pay" = true);


--
-- Name: idx_orders_restaurant_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_orders_restaurant_id" ON "public"."orders" USING "btree" ("restaurant_id");


--
-- Name: idx_payments_restaurant_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_payments_restaurant_id" ON "public"."payments" USING "btree" ("restaurant_id");


--
-- Name: idx_payments_tab_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_payments_tab_id" ON "public"."payments" USING "btree" ("tab_id");


--
-- Name: idx_restaurant_tables_kiosk; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_restaurant_tables_kiosk" ON "public"."restaurant_tables" USING "btree" ("restaurant_id", "is_kiosk") WHERE ("is_kiosk" = true);


--
-- Name: idx_restaurant_terminals_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_restaurant_terminals_active" ON "public"."restaurant_terminals" USING "btree" ("active");


--
-- Name: idx_restaurant_terminals_device_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_restaurant_terminals_device_id" ON "public"."restaurant_terminals" USING "btree" ("device_id");


--
-- Name: idx_restaurant_terminals_restaurant_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_restaurant_terminals_restaurant_id" ON "public"."restaurant_terminals" USING "btree" ("restaurant_id");


--
-- Name: idx_stock_items_restaurant; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_measurement_units_restaurant" ON "public"."measurement_units" USING "btree" ("restaurant_id");


--
-- Name: idx_recipe_items_recipe; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_recipe_items_recipe" ON "public"."recipe_items" USING "btree" ("recipe_id");


--
-- Name: idx_recipe_items_stock_item; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_recipe_items_stock_item" ON "public"."recipe_items" USING "btree" ("stock_item_id");


--
-- Name: idx_recipe_items_unit; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_recipe_items_unit" ON "public"."recipe_items" USING "btree" ("unit_id");


--
-- Name: idx_recipes_menu_item; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_recipes_menu_item" ON "public"."recipes" USING "btree" ("menu_item_id");


--
-- Name: idx_recipes_restaurant; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_recipes_restaurant" ON "public"."recipes" USING "btree" ("restaurant_id");


--
-- Name: idx_stock_items_restaurant; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_stock_items_restaurant" ON "public"."stock_items" USING "btree" ("restaurant_id");


--
-- Name: idx_stock_items_unit; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_stock_items_unit" ON "public"."stock_items" USING "btree" ("unit_id");


--
-- Name: idx_stock_movements_reference; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_stock_movements_reference" ON "public"."stock_movements" USING "btree" ("reference_type", "reference_id");


--
-- Name: idx_stock_movements_restaurant; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_stock_movements_restaurant" ON "public"."stock_movements" USING "btree" ("restaurant_id");


--
-- Name: idx_stock_movements_stock_item; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_stock_movements_stock_item" ON "public"."stock_movements" USING "btree" ("stock_item_id");


--
-- Name: idx_tabs_one_open_per_table; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "idx_tabs_one_open_per_table" ON "public"."tabs" USING "btree" ("restaurant_id", "table_number") WHERE ("status" = 'open'::"text");


--
-- Name: idx_tabs_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "idx_tabs_status" ON "public"."tabs" USING "btree" ("status");


--
-- Name: orders_idempotency_key_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "orders_idempotency_key_unique" ON "public"."orders" USING "btree" ("idempotency_key") WHERE ("idempotency_key" IS NOT NULL);


--
-- Name: orders_paycloud_merchant_order_no_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX "orders_paycloud_merchant_order_no_unique" ON "public"."orders" USING "btree" ("paycloud_merchant_order_no") WHERE ("paycloud_merchant_order_no" IS NOT NULL);


--
-- Name: report_schedules_restaurant_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "report_schedules_restaurant_id_idx" ON "public"."report_schedules" USING "btree" ("restaurant_id");


--
-- Name: restaurant_invites_restaurant_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "restaurant_invites_restaurant_id_idx" ON "public"."restaurant_invites" USING "btree" ("restaurant_id");


--
-- Name: restaurant_terminals_activation_code_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "restaurant_terminals_activation_code_idx" ON "public"."restaurant_terminals" USING "btree" ("activation_code") WHERE ("activation_code" IS NOT NULL);


--
-- Name: restaurant_terminals_refresh_token_hash_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "restaurant_terminals_refresh_token_hash_idx" ON "public"."restaurant_terminals" USING "btree" ("refresh_token_hash") WHERE ("refresh_token_hash" IS NOT NULL);


--
-- Name: restaurant_terminals_restaurant_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "restaurant_terminals_restaurant_id_idx" ON "public"."restaurant_terminals" USING "btree" ("restaurant_id");


--
-- Name: staff_invites_restaurant_id_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "staff_invites_restaurant_id_idx" ON "public"."staff_invites" USING "btree" ("restaurant_id");


--
-- Name: staff_invites_token_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX "staff_invites_token_idx" ON "public"."staff_invites" USING "btree" ("token");


--
-- Name: orders on_new_order_notify_kitchen; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "on_new_order_notify_kitchen" AFTER INSERT ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."notify_kitchen_on_new_order"();


--
-- Name: restaurant_settings settings_version_trigger; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "settings_version_trigger" BEFORE UPDATE ON "public"."restaurant_settings" FOR EACH ROW EXECUTE FUNCTION "public"."increment_settings_version"();


--
-- Name: goods_received trg_assign_grv_number; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "trg_assign_grv_number" BEFORE INSERT ON "public"."goods_received" FOR EACH ROW EXECUTE FUNCTION "public"."assign_grv_number"();


--
-- Name: goods_received_items trg_goods_received_items_creates_movement; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "trg_goods_received_items_creates_movement" AFTER INSERT ON "public"."goods_received_items" FOR EACH ROW EXECUTE FUNCTION "public"."create_movement_from_goods_received_item"();


--
-- Name: orders trg_order_completion_deducts_stock; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "trg_order_completion_deducts_stock" AFTER UPDATE OF "status" ON "public"."orders" FOR EACH ROW WHEN ((("new"."status" = 'completed'::"text") AND ("old"."status" IS DISTINCT FROM 'completed'::"text"))) EXECUTE FUNCTION "public"."trg_order_completion_deducts_stock"();


--
-- Name: audit_logs audit_logs_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: customer_sessions customer_sessions_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."customer_sessions"
    ADD CONSTRAINT "customer_sessions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: customer_sessions customer_sessions_tab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."customer_sessions"
    ADD CONSTRAINT "customer_sessions_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE CASCADE;


--
-- Name: customer_sessions customer_sessions_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."customer_sessions"
    ADD CONSTRAINT "customer_sessions_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE CASCADE;


--
-- Name: daily_analytics daily_analytics_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."daily_analytics"
    ADD CONSTRAINT "daily_analytics_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: goods_received_items goods_received_items_goods_received_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."goods_received_items"
    ADD CONSTRAINT "goods_received_items_goods_received_id_fkey" FOREIGN KEY ("goods_received_id") REFERENCES "public"."goods_received"("id") ON DELETE CASCADE;


--
-- Name: goods_received_items goods_received_items_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."goods_received_items"
    ADD CONSTRAINT "goods_received_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE RESTRICT;


--
-- Name: goods_received goods_received_received_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."goods_received"
    ADD CONSTRAINT "goods_received_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id");


--
-- Name: goods_received goods_received_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."goods_received"
    ADD CONSTRAINT "goods_received_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: inventory_movements inventory_movements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: inventory_movements inventory_movements_menu_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id");


--
-- Name: inventory_movements inventory_movements_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id");


--
-- Name: menu_categories menu_categories_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."menu_categories"
    ADD CONSTRAINT "menu_categories_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: menu_items menu_items_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."menu_categories"("id") ON DELETE CASCADE;


--
-- Name: menu_items menu_items_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: menu_items menu_items_subcategory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_subcategory_id_fkey" FOREIGN KEY ("subcategory_id") REFERENCES "public"."menu_subcategories"("id") ON DELETE CASCADE;


--
-- Name: menu_subcategories menu_subcategories_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."menu_subcategories"
    ADD CONSTRAINT "menu_subcategories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."menu_categories"("id") ON DELETE CASCADE;


--
-- Name: menu_subcategories menu_subcategories_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."menu_subcategories"
    ADD CONSTRAINT "menu_subcategories_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: orders orders_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: orders orders_tab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id");


--
-- Name: orders orders_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id");


--
-- Name: payments payments_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: payments payments_tab_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id");


--
-- Name: payments payments_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id");


--
-- Name: platform_admins platform_admins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."platform_admins"
    ADD CONSTRAINT "platform_admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: platform_audit_logs platform_audit_logs_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."platform_audit_logs"
    ADD CONSTRAINT "platform_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;


--
-- Name: report_schedules report_schedules_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."report_schedules"
    ADD CONSTRAINT "report_schedules_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: report_send_log report_send_log_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."report_send_log"
    ADD CONSTRAINT "report_send_log_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: report_send_log report_send_log_schedule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."report_send_log"
    ADD CONSTRAINT "report_send_log_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "public"."report_schedules"("id") ON DELETE CASCADE;


--
-- Name: restaurant_features restaurant_features_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_features"
    ADD CONSTRAINT "restaurant_features_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: restaurant_invites restaurant_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_invites"
    ADD CONSTRAINT "restaurant_invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE SET NULL;


--
-- Name: restaurant_invites restaurant_invites_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_invites"
    ADD CONSTRAINT "restaurant_invites_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: restaurant_settings restaurant_settings_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_settings"
    ADD CONSTRAINT "restaurant_settings_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: restaurant_setup_status restaurant_setup_status_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_setup_status"
    ADD CONSTRAINT "restaurant_setup_status_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: restaurant_tables restaurant_tables_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_tables"
    ADD CONSTRAINT "restaurant_tables_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: restaurant_terminals restaurant_terminals_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_terminals"
    ADD CONSTRAINT "restaurant_terminals_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: restaurant_users restaurant_users_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_users"
    ADD CONSTRAINT "restaurant_users_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id");


--
-- Name: restaurant_users restaurant_users_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_users"
    ADD CONSTRAINT "restaurant_users_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: restaurant_users restaurant_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurant_users"
    ADD CONSTRAINT "restaurant_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;


--
-- Name: restaurants restaurants_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: restaurants restaurants_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id");


--
-- Name: staff_invites staff_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_invites"
    ADD CONSTRAINT "staff_invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id");


--
-- Name: staff_invites staff_invites_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_invites"
    ADD CONSTRAINT "staff_invites_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: staff_members staff_members_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_members"
    ADD CONSTRAINT "staff_members_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id");


--
-- Name: staff_permissions staff_permissions_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_permissions"
    ADD CONSTRAINT "staff_permissions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: staff_permissions staff_permissions_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."staff_permissions"
    ADD CONSTRAINT "staff_permissions_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_members"("id");


--
-- Name: stock_items stock_items_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."stock_items"
    ADD CONSTRAINT "stock_items_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: stock_movements stock_movements_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");


--
-- Name: stock_movements stock_movements_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: stock_movements stock_movements_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."stock_movements"
    ADD CONSTRAINT "stock_movements_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE RESTRICT;


--
-- Name: subscriptions subscriptions_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: table_assignments table_assignments_restaurant_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."table_assignments"
    ADD CONSTRAINT "table_assignments_restaurant_user_id_fkey" FOREIGN KEY ("restaurant_user_id") REFERENCES "public"."restaurant_users"("id") ON DELETE CASCADE;


--
-- Name: table_assignments table_assignments_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."table_assignments"
    ADD CONSTRAINT "table_assignments_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE CASCADE;


--
-- Name: table_sessions table_sessions_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."table_sessions"
    ADD CONSTRAINT "table_sessions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: table_sessions table_sessions_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."table_sessions"
    ADD CONSTRAINT "table_sessions_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE CASCADE;


--
-- Name: tabs tabs_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."tabs"
    ADD CONSTRAINT "tabs_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: tabs tabs_table_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."tabs"
    ADD CONSTRAINT "tabs_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id");


--
-- Name: terminal_activation_codes terminal_activation_codes_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."terminal_activation_codes"
    ADD CONSTRAINT "terminal_activation_codes_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: terminal_activation_codes terminal_activation_codes_terminal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."terminal_activation_codes"
    ADD CONSTRAINT "terminal_activation_codes_terminal_id_fkey" FOREIGN KEY ("terminal_id") REFERENCES "public"."restaurant_terminals"("id") ON DELETE CASCADE;


--
-- Name: restaurants Allow anon read; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow anon read" ON "public"."restaurants" FOR SELECT TO "anon" USING (true);


--
-- Name: orders Allow anon read orders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow anon read orders" ON "public"."orders" FOR SELECT TO "anon" USING (true);


--
-- Name: orders Allow service update orders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Allow service update orders" ON "public"."orders" FOR UPDATE TO "service_role" USING (true);


--
-- Name: inventory_movements Owners and managers can view inventory movements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners and managers can view inventory movements" ON "public"."inventory_movements" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "inventory_movements"."restaurant_id") AND ("ru"."role" = ANY (ARRAY['owner'::"text", 'manager'::"text"]))))));


--
-- Name: restaurant_features Owners can manage features; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can manage features" ON "public"."restaurant_features" USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "restaurant_features"."restaurant_id") AND ("ru"."role" = 'owner'::"text")))));


--
-- Name: staff_invites Owners can manage invites; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can manage invites" ON "public"."staff_invites" USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "staff_invites"."restaurant_id") AND ("ru"."role" = 'owner'::"text")))));


--
-- Name: goods_received Owners can manage own restaurant goods received; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can manage own restaurant goods received" ON "public"."goods_received" USING (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids"))) WITH CHECK (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")));


--
-- Name: goods_received_items Owners can manage own restaurant goods received items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can manage own restaurant goods received items" ON "public"."goods_received_items" USING (("goods_received_id" IN ( SELECT "goods_received"."id"
   FROM "public"."goods_received"
  WHERE ("goods_received"."restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids"))))) WITH CHECK (("goods_received_id" IN ( SELECT "goods_received"."id"
   FROM "public"."goods_received"
  WHERE ("goods_received"."restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")))));


--
-- Name: stock_items Owners can manage own restaurant stock items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Authenticated users can read system measurement units" ON "public"."measurement_units" FOR SELECT TO "authenticated" USING (("restaurant_id" IS NULL));


--
-- Name: measurement_units Owners can manage own restaurant measurement units; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can manage own restaurant measurement units" ON "public"."measurement_units" USING ((("restaurant_id" IS NOT NULL) AND ("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")))) WITH CHECK ((("restaurant_id" IS NOT NULL) AND ("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids"))));


--
-- Name: recipe_items Owners can manage own restaurant recipe items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can manage own restaurant recipe items" ON "public"."recipe_items" USING (("recipe_id" IN ( SELECT "recipes"."id"
   FROM "public"."recipes"
  WHERE ("recipes"."restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids"))))) WITH CHECK (("recipe_id" IN ( SELECT "recipes"."id"
   FROM "public"."recipes"
  WHERE ("recipes"."restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")))));


--
-- Name: recipes Owners can manage own restaurant recipes; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can manage own restaurant recipes" ON "public"."recipes" USING (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids"))) WITH CHECK (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")));


--
-- Name: stock_items Owners can manage own restaurant stock items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can manage own restaurant stock items" ON "public"."stock_items" USING (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids"))) WITH CHECK (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")));


--
-- Name: stock_movements Owners can manage own restaurant stock movements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can manage own restaurant stock movements" ON "public"."stock_movements" USING (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids"))) WITH CHECK (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")));


--
-- Name: restaurant_terminals Owners can manage terminals; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can manage terminals" ON "public"."restaurant_terminals" USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "restaurant_terminals"."restaurant_id") AND ("ru"."role" = 'owner'::"text")))));


--
-- Name: report_schedules Owners can manage their report schedules; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can manage their report schedules" ON "public"."report_schedules" USING ((EXISTS ( SELECT 1
   FROM "public"."restaurants"
  WHERE (("restaurants"."id" = "report_schedules"."restaurant_id") AND ("restaurants"."owner_id" = "auth"."uid"())))));


--
-- Name: restaurant_settings Owners can manage their settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can manage their settings" ON "public"."restaurant_settings" USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "restaurant_settings"."restaurant_id") AND ("ru"."role" = 'owner'::"text")))));


--
-- Name: restaurant_invites Owners can read own restaurant invites; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can read own restaurant invites" ON "public"."restaurant_invites" FOR SELECT USING (("restaurant_id" IN ( SELECT "restaurant_users"."restaurant_id"
   FROM "public"."restaurant_users"
  WHERE ("restaurant_users"."user_id" = "auth"."uid"()))));


--
-- Name: restaurant_setup_status Owners can read own restaurant setup status; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can read own restaurant setup status" ON "public"."restaurant_setup_status" FOR SELECT USING (("restaurant_id" IN ( SELECT "restaurant_users"."restaurant_id"
   FROM "public"."restaurant_users"
  WHERE ("restaurant_users"."user_id" = "auth"."uid"()))));


--
-- Name: restaurant_terminals Owners can read own restaurant terminals; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can read own restaurant terminals" ON "public"."restaurant_terminals" FOR SELECT USING (("restaurant_id" IN ( SELECT "restaurant_users"."restaurant_id"
   FROM "public"."restaurant_users"
  WHERE ("restaurant_users"."user_id" = "auth"."uid"()))));


--
-- Name: restaurant_setup_status Owners can read own setup status; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can read own setup status" ON "public"."restaurant_setup_status" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "restaurant_setup_status"."restaurant_id") AND ("ru"."role" = 'owner'::"text")))));


--
-- Name: staff_invites Owners can read own staff invites; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can read own staff invites" ON "public"."staff_invites" FOR SELECT USING (("restaurant_id" IN ( SELECT "restaurant_users"."restaurant_id"
   FROM "public"."restaurant_users"
  WHERE ("restaurant_users"."user_id" = "auth"."uid"()))));


--
-- Name: report_send_log Owners can read their report send logs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can read their report send logs" ON "public"."report_send_log" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."restaurants"
  WHERE (("restaurants"."id" = "report_send_log"."restaurant_id") AND ("restaurants"."owner_id" = "auth"."uid"())))));


--
-- Name: subscriptions Owners can read their subscription; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can read their subscription" ON "public"."subscriptions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "subscriptions"."restaurant_id")))));


--
-- Name: restaurant_setup_status Owners can update own restaurant setup status; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can update own restaurant setup status" ON "public"."restaurant_setup_status" FOR UPDATE USING (("restaurant_id" IN ( SELECT "restaurant_users"."restaurant_id"
   FROM "public"."restaurant_users"
  WHERE ("restaurant_users"."user_id" = "auth"."uid"()))));


--
-- Name: restaurant_setup_status Owners can update own setup status; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Owners can update own setup status" ON "public"."restaurant_setup_status" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "restaurant_setup_status"."restaurant_id") AND ("ru"."role" = 'owner'::"text")))));


--
-- Name: platform_audit_logs Platform admins can read audit logs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Platform admins can read audit logs" ON "public"."platform_audit_logs" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."platform_admins"
  WHERE ("platform_admins"."user_id" = "auth"."uid"()))));


--
-- Name: orders Public can create orders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can create orders" ON "public"."orders" FOR INSERT WITH CHECK (true);


--
-- Name: tabs Public can create tabs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can create tabs" ON "public"."tabs" FOR INSERT WITH CHECK (true);


--
-- Name: orders Public can insert orders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can insert orders" ON "public"."orders" FOR INSERT WITH CHECK (true);


--
-- Name: restaurant_features Public can read features; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can read features" ON "public"."restaurant_features" FOR SELECT USING (true);


--
-- Name: menu_categories Public can read menu categories; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can read menu categories" ON "public"."menu_categories" FOR SELECT USING (true);


--
-- Name: menu_items Public can read menu items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can read menu items" ON "public"."menu_items" FOR SELECT USING (true);


--
-- Name: menu_subcategories Public can read menu subcategories; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can read menu subcategories" ON "public"."menu_subcategories" FOR SELECT USING (true);


--
-- Name: orders Public can read open orders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can read open orders" ON "public"."orders" FOR SELECT USING (("is_closed" = false));


--
-- Name: orders Public can read orders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can read orders" ON "public"."orders" FOR SELECT USING (true);


--
-- Name: restaurants Public can read restaurants; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can read restaurants" ON "public"."restaurants" FOR SELECT USING (true);


--
-- Name: restaurant_settings Public can read settings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can read settings" ON "public"."restaurant_settings" FOR SELECT USING (true);


--
-- Name: restaurant_tables Public can read tables; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can read tables" ON "public"."restaurant_tables" FOR SELECT USING (true);


--
-- Name: tabs Public can read tabs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can read tabs" ON "public"."tabs" FOR SELECT USING (true);


--
-- Name: tabs Public can update tabs; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Public can update tabs" ON "public"."tabs" FOR UPDATE USING (true);


--
-- Name: orders Staff can read orders for their restaurant; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Staff can read orders for their restaurant" ON "public"."orders" FOR SELECT TO "authenticated" USING (("restaurant_id" IN ( SELECT "staff_members"."restaurant_id"
   FROM "public"."staff_members"
  WHERE (("staff_members"."email" = ("auth"."jwt"() ->> 'email'::"text")) AND ("staff_members"."active" = true)))));


--
-- Name: staff_permissions Staff can read own permissions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Staff can read own permissions" ON "public"."staff_permissions" FOR SELECT TO "authenticated" USING (("staff_id" IN ( SELECT "staff_members"."id"
   FROM "public"."staff_members"
  WHERE ("staff_members"."email" = ("auth"."jwt"() ->> 'email'::"text")))));


--
-- Name: staff_members Staff can read own record; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Staff can read own record" ON "public"."staff_members" FOR SELECT TO "authenticated" USING (("email" = ("auth"."jwt"() ->> 'email'::"text")));


--
-- Name: orders Staff can update orders for their restaurant; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Staff can update orders for their restaurant" ON "public"."orders" FOR UPDATE TO "authenticated" USING (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids"))) WITH CHECK (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")));



CREATE POLICY "Guest can mark order ready for terminal" ON "public"."orders" FOR UPDATE TO "anon" USING ((COALESCE("is_closed", false) = false) AND (COALESCE("status", ''::"text") <> ALL (ARRAY['completed'::"text", 'cancelled'::"text"]))) WITH CHECK (("status" = 'ready_for_terminal'::"text"));


--
-- Name: staff_members Staff can update own push token; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Staff can update own push token" ON "public"."staff_members" FOR UPDATE TO "authenticated" USING (("email" = ("auth"."jwt"() ->> 'email'::"text"))) WITH CHECK (("email" = ("auth"."jwt"() ->> 'email'::"text")));


--
-- Name: staff_members Staff can update own record; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Staff can update own record" ON "public"."staff_members" FOR UPDATE TO "authenticated" USING (("email" = ("auth"."jwt"() ->> 'email'::"text"))) WITH CHECK (("email" = ("auth"."jwt"() ->> 'email'::"text")));


--
-- Name: restaurants Users can read own restaurant; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can read own restaurant" ON "public"."restaurants" FOR SELECT USING (("id" IN ( SELECT "users"."restaurant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));


--
-- Name: restaurant_users Users can read own restaurant_users row; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can read own restaurant_users row" ON "public"."restaurant_users" FOR SELECT USING (("auth"."uid"() = "user_id"));


--
-- Name: users Users can read own row; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can read own row" ON "public"."users" FOR SELECT USING (("auth"."uid"() = "id"));


--
-- Name: users Users can read own user row; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can read own user row" ON "public"."users" FOR SELECT USING (("auth"."uid"() = "id"));


--
-- Name: restaurant_users Users can read team in their restaurant; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can read team in their restaurant" ON "public"."restaurant_users" FOR SELECT USING (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")));


--
-- Name: users Users can update own row; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Users can update own row" ON "public"."users" FOR UPDATE USING (("auth"."uid"() = "id"));


--
-- Name: orders anon can read orders; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "anon can read orders" ON "public"."orders" FOR SELECT USING (true);


--
-- Name: menu_items anon read menu_items; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "anon read menu_items" ON "public"."menu_items" FOR SELECT TO "anon" USING (true);


--
-- Name: audit_logs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;

--
-- Name: bug_reports; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."bug_reports" ENABLE ROW LEVEL SECURITY;

--
-- Name: bug_reports bug_reports_insert_own_restaurant; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bug_reports_insert_own_restaurant" ON "public"."bug_reports" FOR INSERT TO "authenticated" WITH CHECK (("restaurant_id" IN ( SELECT "users"."restaurant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));


--
-- Name: bug_reports bug_reports_select_own_restaurant; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "bug_reports_select_own_restaurant" ON "public"."bug_reports" FOR SELECT TO "authenticated" USING (("restaurant_id" IN ( SELECT "users"."restaurant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));


--
-- Name: goods_received; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."goods_received" ENABLE ROW LEVEL SECURITY;

--
-- Name: goods_received_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."goods_received_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: inventory_movements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."inventory_movements" ENABLE ROW LEVEL SECURITY;

--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_admins; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."platform_admins" ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_audit_logs; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."platform_audit_logs" ENABLE ROW LEVEL SECURITY;

--
-- Name: report_schedules; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."report_schedules" ENABLE ROW LEVEL SECURITY;

--
-- Name: report_send_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."recipe_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: recipes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."recipes" ENABLE ROW LEVEL SECURITY;

--
-- Name: report_send_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."report_send_log" ENABLE ROW LEVEL SECURITY;

--
-- Name: restaurant_features; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."restaurant_features" ENABLE ROW LEVEL SECURITY;

--
-- Name: restaurant_invites; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."restaurant_invites" ENABLE ROW LEVEL SECURITY;

--
-- Name: restaurant_settings; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."restaurant_settings" ENABLE ROW LEVEL SECURITY;

--
-- Name: restaurant_setup_status; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."restaurant_setup_status" ENABLE ROW LEVEL SECURITY;

--
-- Name: restaurant_terminals; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."restaurant_terminals" ENABLE ROW LEVEL SECURITY;

--
-- Name: restaurant_users; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."restaurant_users" ENABLE ROW LEVEL SECURITY;

--
-- Name: orders service role can update orders; Type: POLICY; Schema: public; Owner: postgres
--

-- Removed: "service role can update orders" (was FOR UPDATE USING (true) on public — P0 lockdown)

--
-- Name: staff_invites; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."staff_invites" ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_members; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."staff_members" ENABLE ROW LEVEL SECURITY;

--
-- Name: staff_permissions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."staff_permissions" ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."stock_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: stock_movements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."stock_movements" ENABLE ROW LEVEL SECURITY;

--
-- Name: subscriptions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;

--
-- Name: table_assignments; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."table_assignments" ENABLE ROW LEVEL SECURITY;

--
-- Name: terminal_activation_codes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."terminal_activation_codes" ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA "public"; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";


--
-- Name: FUNCTION "assign_grv_number"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."assign_grv_number"() TO "anon";
GRANT ALL ON FUNCTION "public"."assign_grv_number"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assign_grv_number"() TO "service_role";


--
-- Name: FUNCTION "close_table_session"("p_table_id" "uuid", "p_restaurant_id" "uuid"); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."close_table_session"("p_table_id" "uuid", "p_restaurant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."close_table_session"("p_table_id" "uuid", "p_restaurant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."close_table_session"("p_table_id" "uuid", "p_restaurant_id" "uuid") TO "service_role";


--
-- Name: FUNCTION "create_movement_from_goods_received_item"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."create_movement_from_goods_received_item"() TO "anon";
GRANT ALL ON FUNCTION "public"."create_movement_from_goods_received_item"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_movement_from_goods_received_item"() TO "service_role";


--
-- Name: FUNCTION "deduct_recipe_stock"(uuid); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."deduct_recipe_stock"("uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deduct_recipe_stock"("uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deduct_recipe_stock"("uuid") TO "service_role";


--
-- Name: FUNCTION "trg_order_completion_deducts_stock"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."trg_order_completion_deducts_stock"() TO "anon";
GRANT ALL ON FUNCTION "public"."trg_order_completion_deducts_stock"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trg_order_completion_deducts_stock"() TO "service_role";


--
-- Name: FUNCTION "increment_settings_version"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."increment_settings_version"() TO "anon";
GRANT ALL ON FUNCTION "public"."increment_settings_version"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_settings_version"() TO "service_role";


--
-- Name: FUNCTION "notify_kitchen_on_new_order"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."notify_kitchen_on_new_order"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_kitchen_on_new_order"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_kitchen_on_new_order"() TO "service_role";


--
-- Name: FUNCTION "user_restaurant_ids"(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION "public"."user_restaurant_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."user_restaurant_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_restaurant_ids"() TO "service_role";


--
-- Name: TABLE "audit_logs"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";


--
-- Name: TABLE "bug_reports"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."bug_reports" TO "anon";
GRANT ALL ON TABLE "public"."bug_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."bug_reports" TO "service_role";


--
-- Name: TABLE "customer_sessions"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."customer_sessions" TO "anon";
GRANT ALL ON TABLE "public"."customer_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_sessions" TO "service_role";


--
-- Name: TABLE "daily_analytics"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."daily_analytics" TO "anon";
GRANT ALL ON TABLE "public"."daily_analytics" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_analytics" TO "service_role";


--
-- Name: TABLE "goods_received"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."goods_received" TO "anon";
GRANT ALL ON TABLE "public"."goods_received" TO "authenticated";
GRANT ALL ON TABLE "public"."goods_received" TO "service_role";


--
-- Name: TABLE "goods_received_items"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."goods_received_items" TO "anon";
GRANT ALL ON TABLE "public"."goods_received_items" TO "authenticated";
GRANT ALL ON TABLE "public"."goods_received_items" TO "service_role";


--
-- Name: SEQUENCE "grv_number_seq"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON SEQUENCE "public"."grv_number_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."grv_number_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."grv_number_seq" TO "service_role";


--
-- Name: TABLE "inventory_movements"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."inventory_movements" TO "anon";
GRANT ALL ON TABLE "public"."inventory_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_movements" TO "service_role";


--
-- Name: TABLE "menu_categories"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."menu_categories" TO "anon";
GRANT ALL ON TABLE "public"."menu_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_categories" TO "service_role";


--
-- Name: TABLE "menu_items"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."menu_items" TO "anon";
GRANT ALL ON TABLE "public"."menu_items" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_items" TO "service_role";


--
-- Name: TABLE "measurement_units"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."measurement_units" TO "anon";
GRANT ALL ON TABLE "public"."measurement_units" TO "authenticated";
GRANT ALL ON TABLE "public"."measurement_units" TO "service_role";


--
-- Name: TABLE "recipe_items"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."recipe_items" TO "anon";
GRANT ALL ON TABLE "public"."recipe_items" TO "authenticated";
GRANT ALL ON TABLE "public"."recipe_items" TO "service_role";


--
-- Name: TABLE "recipes"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."recipes" TO "anon";
GRANT ALL ON TABLE "public"."recipes" TO "authenticated";
GRANT ALL ON TABLE "public"."recipes" TO "service_role";


--
-- Name: TABLE "menu_subcategories"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."menu_subcategories" TO "anon";
GRANT ALL ON TABLE "public"."menu_subcategories" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_subcategories" TO "service_role";


--
-- Name: TABLE "orders"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT ALL ON TABLE "public"."orders" TO "service_role";


--
-- Name: TABLE "payments"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";


--
-- Name: TABLE "platform_admins"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."platform_admins" TO "anon";
GRANT ALL ON TABLE "public"."platform_admins" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_admins" TO "service_role";


--
-- Name: TABLE "platform_audit_logs"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."platform_audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."platform_audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_audit_logs" TO "service_role";


--
-- Name: TABLE "restaurant_settings"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."restaurant_settings" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_settings" TO "service_role";


--
-- Name: TABLE "public_restaurant_settings"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."public_restaurant_settings" TO "anon";
GRANT ALL ON TABLE "public"."public_restaurant_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."public_restaurant_settings" TO "service_role";


--
-- Name: TABLE "report_schedules"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."report_schedules" TO "anon";
GRANT ALL ON TABLE "public"."report_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."report_schedules" TO "service_role";


--
-- Name: TABLE "report_send_log"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."report_send_log" TO "anon";
GRANT ALL ON TABLE "public"."report_send_log" TO "authenticated";
GRANT ALL ON TABLE "public"."report_send_log" TO "service_role";


--
-- Name: TABLE "restaurant_features"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."restaurant_features" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_features" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_features" TO "service_role";


--
-- Name: TABLE "restaurant_invites"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."restaurant_invites" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_invites" TO "service_role";


--
-- Name: TABLE "restaurant_setup_status"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."restaurant_setup_status" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_setup_status" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_setup_status" TO "service_role";


--
-- Name: TABLE "restaurant_tables"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."restaurant_tables" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_tables" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_tables" TO "service_role";


--
-- Name: TABLE "restaurant_terminals"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."restaurant_terminals" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_terminals" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_terminals" TO "service_role";


--
-- Name: TABLE "restaurant_users"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."restaurant_users" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_users" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_users" TO "service_role";


--
-- Name: TABLE "restaurants"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."restaurants" TO "anon";
GRANT ALL ON TABLE "public"."restaurants" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurants" TO "service_role";


--
-- Name: TABLE "staff_invites"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."staff_invites" TO "anon";
GRANT ALL ON TABLE "public"."staff_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_invites" TO "service_role";


--
-- Name: TABLE "staff_members"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."staff_members" TO "anon";
GRANT ALL ON TABLE "public"."staff_members" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_members" TO "service_role";


--
-- Name: TABLE "staff_permissions"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."staff_permissions" TO "anon";
GRANT ALL ON TABLE "public"."staff_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_permissions" TO "service_role";


--
-- Name: TABLE "stock_items"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."stock_items" TO "anon";
GRANT ALL ON TABLE "public"."stock_items" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_items" TO "service_role";


--
-- Name: TABLE "stock_movements"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."stock_movements" TO "anon";
GRANT ALL ON TABLE "public"."stock_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."stock_movements" TO "service_role";


--
-- Name: TABLE "subscriptions"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";


--
-- Name: TABLE "table_assignments"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."table_assignments" TO "anon";
GRANT ALL ON TABLE "public"."table_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."table_assignments" TO "service_role";


--
-- Name: TABLE "table_sessions"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."table_sessions" TO "anon";
GRANT ALL ON TABLE "public"."table_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."table_sessions" TO "service_role";


--
-- Name: TABLE "tabs"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."tabs" TO "anon";
GRANT ALL ON TABLE "public"."tabs" TO "authenticated";
GRANT ALL ON TABLE "public"."tabs" TO "service_role";


--
-- Name: TABLE "terminal_activation_codes"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."terminal_activation_codes" TO "anon";
GRANT ALL ON TABLE "public"."terminal_activation_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."terminal_activation_codes" TO "service_role";


--
-- Name: TABLE "users"; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: postgres
--

ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: supabase_admin
--

-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
-- ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";


--
-- Name: rct_number_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--
-- Receipt capability Phase 1 (supabase/migrations/20260717140000_receipt_documents.sql).
-- Mirrors the grv_number_seq pattern: dedicated sequence, RCT- prefix, LPAD-6.
--

CREATE SEQUENCE IF NOT EXISTS "public"."rct_number_seq" START WITH 1;

ALTER SEQUENCE "public"."rct_number_seq" OWNER TO "postgres";

--
-- Name: generate_document_number(text, text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."generate_document_number"("p_prefix" "text", "p_sequence_name" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN p_prefix || '-' || LPAD(nextval(p_sequence_name)::text, 6, '0');
END;
$$;

ALTER FUNCTION "public"."generate_document_number"("p_prefix" "text", "p_sequence_name" "text") OWNER TO "postgres";

GRANT EXECUTE ON FUNCTION "public"."generate_document_number"("p_prefix" "text", "p_sequence_name" "text") TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."generate_document_number"("p_prefix" "text", "p_sequence_name" "text") TO "service_role";

--
-- Name: receipt_documents; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."receipt_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "outlet_id" "uuid",
    "order_id" "uuid" NOT NULL,
    "document_type" "text" DEFAULT 'SALE_RECEIPT'::"text" NOT NULL,
    "document_number" "text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "status" "text" DEFAULT 'issued'::"text" NOT NULL,
    "currency" "text" DEFAULT 'NAD'::"text" NOT NULL,
    "snapshot_json" "jsonb" NOT NULL,
    "issued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "receipt_documents_document_type_check" CHECK (("document_type" = 'SALE_RECEIPT'::"text")),
    CONSTRAINT "receipt_documents_status_check" CHECK (("status" = ANY (ARRAY['issued'::"text", 'void'::"text"])))
);

-- outlet_id: no outlets table exists yet. Nullable so this is forward-compatible with
-- future multi-outlet modeling; not wired to anything today.

ALTER TABLE "public"."receipt_documents" OWNER TO "postgres";

ALTER TABLE ONLY "public"."receipt_documents"
    ADD CONSTRAINT "receipt_documents_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "public"."receipt_documents"
    ADD CONSTRAINT "receipt_documents_order_id_document_type_version_key" UNIQUE ("order_id", "document_type", "version");

CREATE INDEX "receipt_documents_restaurant_id_idx" ON "public"."receipt_documents" USING "btree" ("restaurant_id");

CREATE INDEX "receipt_documents_order_id_idx" ON "public"."receipt_documents" USING "btree" ("order_id");

ALTER TABLE ONLY "public"."receipt_documents"
    ADD CONSTRAINT "receipt_documents_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id");

ALTER TABLE ONLY "public"."receipt_documents"
    ADD CONSTRAINT "receipt_documents_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id");

ALTER TABLE "public"."receipt_documents" ENABLE ROW LEVEL SECURITY;

-- No insert/update/delete policies and no grants beyond the schema-wide default ACLs below --
-- rows are written exclusively by the service role (bypasses RLS), so the table is immutable
-- at the database level for application users, not just by convention.
CREATE POLICY "Staff can read receipt documents for their restaurant" ON "public"."receipt_documents" FOR SELECT TO "authenticated" USING (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")));

--
-- Name: receipt_deliveries; Type: TABLE; Schema: public; Owner: postgres
--
-- Receipt capability Phase 2 (supabase/migrations/20260717160000_receipt_deliveries_and_terminal_printer_configs.sql).
--

CREATE TABLE IF NOT EXISTS "public"."receipt_deliveries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "receipt_document_id" "uuid" NOT NULL,
    "method" "text" NOT NULL,
    "destination" "text",
    "status" "text" NOT NULL,
    "attempt_number" integer DEFAULT 1 NOT NULL,
    "provider" "text",
    "provider_reference" "text",
    "device_id" "text",
    "requested_by" "uuid",
    "error_code" "text",
    "error_message" "text",
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "receipt_deliveries_method_check" CHECK (("method" = 'PRINT'::"text")),
    CONSTRAINT "receipt_deliveries_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'failed'::"text"])))
);

ALTER TABLE "public"."receipt_deliveries" OWNER TO "postgres";

ALTER TABLE ONLY "public"."receipt_deliveries"
    ADD CONSTRAINT "receipt_deliveries_pkey" PRIMARY KEY ("id");

CREATE INDEX "receipt_deliveries_receipt_document_id_idx" ON "public"."receipt_deliveries" USING "btree" ("receipt_document_id");

CREATE INDEX "receipt_deliveries_status_idx" ON "public"."receipt_deliveries" USING "btree" ("status");

ALTER TABLE ONLY "public"."receipt_deliveries"
    ADD CONSTRAINT "receipt_deliveries_receipt_document_id_fkey" FOREIGN KEY ("receipt_document_id") REFERENCES "public"."receipt_documents"("id");

ALTER TABLE ONLY "public"."receipt_deliveries"
    ADD CONSTRAINT "receipt_deliveries_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "auth"."users"("id");

ALTER TABLE "public"."receipt_deliveries" ENABLE ROW LEVEL SECURITY;

-- No update policy -- a retry is a new row (attempt_number incremented), never an edit to a
-- prior attempt. No insert/delete policy or grants either: rows are written exclusively by
-- the service role, same as receipt_documents.
CREATE POLICY "Staff can read receipt deliveries for their restaurant" ON "public"."receipt_deliveries" FOR SELECT TO "authenticated" USING (("receipt_document_id" IN ( SELECT "receipt_documents"."id" FROM "public"."receipt_documents" WHERE ("receipt_documents"."restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")))));

--
-- Name: terminal_printer_configs; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."terminal_printer_configs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "terminal_id" "text" NOT NULL,
    "purpose" "text" DEFAULT 'CUSTOMER_RECEIPT'::"text" NOT NULL,
    "connection_type" "text" DEFAULT 'BLUETOOTH'::"text" NOT NULL,
    "printer_name" "text",
    "printer_address" "text",
    "paper_width_mm" integer DEFAULT 80 NOT NULL,
    "character_width" integer,
    "is_default" boolean DEFAULT true NOT NULL,
    "last_connected_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "terminal_printer_configs_purpose_check" CHECK (("purpose" = 'CUSTOMER_RECEIPT'::"text")),
    CONSTRAINT "terminal_printer_configs_connection_type_check" CHECK (("connection_type" = 'BLUETOOTH'::"text"))
);

-- terminal_id matches the terminal identity convention already used elsewhere (e.g.
-- payment_events.terminal_id): restaurant_terminals.id, the JWT `sub` issued by
-- requireTerminalAuth() -- not device_id/device_serial/sn.

ALTER TABLE "public"."terminal_printer_configs" OWNER TO "postgres";

ALTER TABLE ONLY "public"."terminal_printer_configs"
    ADD CONSTRAINT "terminal_printer_configs_pkey" PRIMARY KEY ("id");

CREATE INDEX "terminal_printer_configs_terminal_id_idx" ON "public"."terminal_printer_configs" USING "btree" ("terminal_id");

ALTER TABLE "public"."terminal_printer_configs" ENABLE ROW LEVEL SECURITY;

-- No restaurant_id column -- this is device-level data, not staff-level, so
-- user_restaurant_ids() can't apply directly. Scope reads by joining through
-- restaurant_terminals (the same join-through-parent shape already used for e.g.
-- goods_received_items, which also has no restaurant_id of its own). Writes are
-- service-role only (the terminal's own authenticated API) -- no insert/update/delete
-- policy or grants here.
CREATE POLICY "Staff can read printer configs for their restaurant's terminals" ON "public"."terminal_printer_configs" FOR SELECT TO "authenticated" USING (("terminal_id" IN ( SELECT ("restaurant_terminals"."id")::"text" AS "id" FROM "public"."restaurant_terminals" WHERE ("restaurant_terminals"."restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")))));

--
-- PostgreSQL database dump complete
--

-- \unrestrict 58h7FxN5fqmM5IG7wtG1yfBn3iEROmOwELFL64fnDl1gtCnPq9mT2eq74rMcLdE

