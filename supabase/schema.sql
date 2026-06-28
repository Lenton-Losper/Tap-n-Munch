


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






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

SET default_tablespace = '';

SET default_table_access_method = "heap";


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


CREATE TABLE IF NOT EXISTS "public"."bug_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid",
    "description" "text" NOT NULL,
    "area" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."bug_reports" OWNER TO "postgres";


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
    "customer_ready_to_pay" boolean DEFAULT false
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


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
    "settings_version" integer DEFAULT 1 NOT NULL
);


ALTER TABLE "public"."restaurant_settings" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."public_restaurant_settings" AS
 SELECT "restaurant_id",
    "currency",
    "payment_methods",
    "tab_pin_required",
    "max_tab_hours"
   FROM "public"."restaurant_settings";


ALTER VIEW "public"."public_restaurant_settings" OWNER TO "postgres";


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
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."restaurant_features" OWNER TO "postgres";


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
    "status" "text" DEFAULT 'available'::"text"
);


ALTER TABLE "public"."restaurant_tables" OWNER TO "postgres";


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
    CONSTRAINT "restaurant_users_role_check" CHECK (("role" = ANY (ARRAY['owner'::"text", 'manager'::"text", 'waiter'::"text"])))
);


ALTER TABLE "public"."restaurant_users" OWNER TO "postgres";


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
    CONSTRAINT "staff_invites_role_check" CHECK (("role" = ANY (ARRAY['manager'::"text", 'waiter'::"text"])))
);


ALTER TABLE "public"."staff_invites" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."staff_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid",
    "email" "text",
    "role" "text",
    "active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "push_token" "text"
);


ALTER TABLE "public"."staff_members" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."staff_permissions" (
    "staff_id" "uuid" NOT NULL,
    "permission" "text" NOT NULL
);


ALTER TABLE "public"."staff_permissions" OWNER TO "postgres";


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


CREATE TABLE IF NOT EXISTS "public"."table_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_user_id" "uuid" NOT NULL,
    "table_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."table_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."table_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "table_id" "uuid",
    "restaurant_id" "uuid",
    "status" "text" DEFAULT 'active'::"text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "closed_at" timestamp with time zone
);


ALTER TABLE "public"."table_sessions" OWNER TO "postgres";


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
    CONSTRAINT "tab_pin_format" CHECK ((("tab_pin")::"text" ~ '^[0-9]{4}$'::"text"))
);


ALTER TABLE "public"."tabs" OWNER TO "postgres";


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


ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bug_reports"
    ADD CONSTRAINT "bug_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_sessions"
    ADD CONSTRAINT "customer_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."customer_sessions"
    ADD CONSTRAINT "customer_sessions_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."daily_analytics"
    ADD CONSTRAINT "daily_analytics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."daily_analytics"
    ADD CONSTRAINT "daily_analytics_restaurant_id_date_key" UNIQUE ("restaurant_id", "date");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."menu_categories"
    ADD CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."menu_subcategories"
    ADD CONSTRAINT "menu_subcategories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_firebase_id_key" UNIQUE ("firebase_id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."restaurant_features"
    ADD CONSTRAINT "restaurant_features_pkey" PRIMARY KEY ("restaurant_id");



ALTER TABLE ONLY "public"."restaurant_settings"
    ADD CONSTRAINT "restaurant_settings_pkey" PRIMARY KEY ("restaurant_id");



ALTER TABLE ONLY "public"."restaurant_setup_status"
    ADD CONSTRAINT "restaurant_setup_status_pkey" PRIMARY KEY ("restaurant_id");



ALTER TABLE ONLY "public"."restaurant_tables"
    ADD CONSTRAINT "restaurant_tables_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."restaurant_terminals"
    ADD CONSTRAINT "restaurant_terminals_device_id_unique" UNIQUE ("device_id");



ALTER TABLE ONLY "public"."restaurant_terminals"
    ADD CONSTRAINT "restaurant_terminals_device_serial_unique" UNIQUE ("device_serial");



ALTER TABLE ONLY "public"."restaurant_terminals"
    ADD CONSTRAINT "restaurant_terminals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."restaurant_users"
    ADD CONSTRAINT "restaurant_users_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."restaurant_users"
    ADD CONSTRAINT "restaurant_users_restaurant_id_user_id_key" UNIQUE ("restaurant_id", "user_id");



ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_firebase_id_key" UNIQUE ("firebase_id");



ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_subdomain_key" UNIQUE ("subdomain");



ALTER TABLE ONLY "public"."staff_invites"
    ADD CONSTRAINT "staff_invites_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."staff_invites"
    ADD CONSTRAINT "staff_invites_restaurant_id_email_key" UNIQUE ("restaurant_id", "email");



ALTER TABLE ONLY "public"."staff_members"
    ADD CONSTRAINT "staff_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."staff_permissions"
    ADD CONSTRAINT "staff_permissions_pkey" PRIMARY KEY ("staff_id", "permission");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."table_assignments"
    ADD CONSTRAINT "table_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."table_assignments"
    ADD CONSTRAINT "table_assignments_restaurant_user_id_table_id_key" UNIQUE ("restaurant_user_id", "table_id");



ALTER TABLE ONLY "public"."table_sessions"
    ADD CONSTRAINT "table_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tabs"
    ADD CONSTRAINT "tabs_firebase_id_key" UNIQUE ("firebase_id");



ALTER TABLE ONLY "public"."tabs"
    ADD CONSTRAINT "tabs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_firebase_uid_key" UNIQUE ("firebase_uid");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");



CREATE INDEX "audit_logs_restaurant_id_idx" ON "public"."audit_logs" USING "btree" ("restaurant_id");



CREATE INDEX "idx_customer_sessions_active" ON "public"."customer_sessions" USING "btree" ("active");



CREATE INDEX "idx_customer_sessions_tab_id" ON "public"."customer_sessions" USING "btree" ("tab_id");



CREATE UNIQUE INDEX "idx_customer_sessions_token" ON "public"."customer_sessions" USING "btree" ("token");



CREATE UNIQUE INDEX "idx_orders_idempotency_key" ON "public"."orders" USING "btree" ("idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "idx_orders_ready_to_pay" ON "public"."orders" USING "btree" ("restaurant_id", "customer_ready_to_pay") WHERE ("customer_ready_to_pay" = true);



CREATE INDEX "idx_orders_restaurant_id" ON "public"."orders" USING "btree" ("restaurant_id");



CREATE INDEX "idx_payments_restaurant_id" ON "public"."payments" USING "btree" ("restaurant_id");



CREATE INDEX "idx_payments_tab_id" ON "public"."payments" USING "btree" ("tab_id");



CREATE INDEX "idx_restaurant_terminals_active" ON "public"."restaurant_terminals" USING "btree" ("active");



CREATE INDEX "idx_restaurant_terminals_device_id" ON "public"."restaurant_terminals" USING "btree" ("device_id");



CREATE INDEX "idx_restaurant_terminals_restaurant_id" ON "public"."restaurant_terminals" USING "btree" ("restaurant_id");



CREATE UNIQUE INDEX "idx_tabs_one_open_per_table" ON "public"."tabs" USING "btree" ("restaurant_id", "table_number") WHERE ("status" = 'open'::"text");



CREATE INDEX "idx_tabs_status" ON "public"."tabs" USING "btree" ("status");



CREATE UNIQUE INDEX "orders_idempotency_key_unique" ON "public"."orders" USING "btree" ("idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "restaurant_terminals_activation_code_idx" ON "public"."restaurant_terminals" USING "btree" ("activation_code") WHERE ("activation_code" IS NOT NULL);



CREATE INDEX "restaurant_terminals_refresh_token_hash_idx" ON "public"."restaurant_terminals" USING "btree" ("refresh_token_hash") WHERE ("refresh_token_hash" IS NOT NULL);



CREATE OR REPLACE TRIGGER "on_new_order_notify_kitchen" AFTER INSERT ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."notify_kitchen_on_new_order"();



CREATE OR REPLACE TRIGGER "settings_version_trigger" BEFORE UPDATE ON "public"."restaurant_settings" FOR EACH ROW EXECUTE FUNCTION "public"."increment_settings_version"();



ALTER TABLE ONLY "public"."audit_logs"
    ADD CONSTRAINT "audit_logs_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_sessions"
    ADD CONSTRAINT "customer_sessions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_sessions"
    ADD CONSTRAINT "customer_sessions_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."customer_sessions"
    ADD CONSTRAINT "customer_sessions_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."daily_analytics"
    ADD CONSTRAINT "daily_analytics_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id");



ALTER TABLE ONLY "public"."menu_categories"
    ADD CONSTRAINT "menu_categories_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."menu_categories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."menu_items"
    ADD CONSTRAINT "menu_items_subcategory_id_fkey" FOREIGN KEY ("subcategory_id") REFERENCES "public"."menu_subcategories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."menu_subcategories"
    ADD CONSTRAINT "menu_subcategories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."menu_categories"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."menu_subcategories"
    ADD CONSTRAINT "menu_subcategories_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_tab_id_fkey" FOREIGN KEY ("tab_id") REFERENCES "public"."tabs"("id");



ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id");



ALTER TABLE ONLY "public"."restaurant_features"
    ADD CONSTRAINT "restaurant_features_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."restaurant_settings"
    ADD CONSTRAINT "restaurant_settings_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."restaurant_setup_status"
    ADD CONSTRAINT "restaurant_setup_status_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."restaurant_tables"
    ADD CONSTRAINT "restaurant_tables_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."restaurant_terminals"
    ADD CONSTRAINT "restaurant_terminals_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."restaurant_users"
    ADD CONSTRAINT "restaurant_users_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."restaurant_users"
    ADD CONSTRAINT "restaurant_users_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."restaurant_users"
    ADD CONSTRAINT "restaurant_users_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."staff_invites"
    ADD CONSTRAINT "staff_invites_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id");



ALTER TABLE ONLY "public"."staff_invites"
    ADD CONSTRAINT "staff_invites_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."staff_members"
    ADD CONSTRAINT "staff_members_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id");



ALTER TABLE ONLY "public"."staff_permissions"
    ADD CONSTRAINT "staff_permissions_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_members"("id");



ALTER TABLE ONLY "public"."subscriptions"
    ADD CONSTRAINT "subscriptions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."table_assignments"
    ADD CONSTRAINT "table_assignments_restaurant_user_id_fkey" FOREIGN KEY ("restaurant_user_id") REFERENCES "public"."restaurant_users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."table_assignments"
    ADD CONSTRAINT "table_assignments_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."table_sessions"
    ADD CONSTRAINT "table_sessions_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."table_sessions"
    ADD CONSTRAINT "table_sessions_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tabs"
    ADD CONSTRAINT "tabs_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tabs"
    ADD CONSTRAINT "tabs_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "public"."restaurant_tables"("id");



CREATE POLICY "Allow anon read" ON "public"."restaurants" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Allow anon read orders" ON "public"."orders" FOR SELECT TO "anon" USING (true);



CREATE POLICY "Allow service update orders" ON "public"."orders" FOR UPDATE TO "service_role" USING (true);



CREATE POLICY "Owners and managers can view inventory movements" ON "public"."inventory_movements" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "inventory_movements"."restaurant_id") AND ("ru"."role" = ANY (ARRAY['owner'::"text", 'manager'::"text"]))))));



CREATE POLICY "Owners can manage features" ON "public"."restaurant_features" USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "restaurant_features"."restaurant_id") AND ("ru"."role" = 'owner'::"text")))));



CREATE POLICY "Owners can manage invites" ON "public"."staff_invites" USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "staff_invites"."restaurant_id") AND ("ru"."role" = 'owner'::"text")))));



CREATE POLICY "Owners can manage terminals" ON "public"."restaurant_terminals" USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "restaurant_terminals"."restaurant_id") AND ("ru"."role" = 'owner'::"text")))));



CREATE POLICY "Owners can manage their settings" ON "public"."restaurant_settings" USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "restaurant_settings"."restaurant_id") AND ("ru"."role" = 'owner'::"text")))));



CREATE POLICY "Owners can read own setup status" ON "public"."restaurant_setup_status" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "restaurant_setup_status"."restaurant_id") AND ("ru"."role" = 'owner'::"text")))));



CREATE POLICY "Owners can read their subscription" ON "public"."subscriptions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "subscriptions"."restaurant_id")))));



CREATE POLICY "Owners can update own setup status" ON "public"."restaurant_setup_status" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "restaurant_setup_status"."restaurant_id") AND ("ru"."role" = 'owner'::"text")))));



CREATE POLICY "Public can create orders" ON "public"."orders" FOR INSERT WITH CHECK (true);



CREATE POLICY "Public can create tabs" ON "public"."tabs" FOR INSERT WITH CHECK (true);



CREATE POLICY "Public can insert orders" ON "public"."orders" FOR INSERT WITH CHECK (true);



CREATE POLICY "Public can read features" ON "public"."restaurant_features" FOR SELECT USING (true);



CREATE POLICY "Public can read menu categories" ON "public"."menu_categories" FOR SELECT USING (true);



CREATE POLICY "Public can read menu items" ON "public"."menu_items" FOR SELECT USING (true);



CREATE POLICY "Public can read menu subcategories" ON "public"."menu_subcategories" FOR SELECT USING (true);



CREATE POLICY "Public can read open orders" ON "public"."orders" FOR SELECT USING (("is_closed" = false));



CREATE POLICY "Public can read orders" ON "public"."orders" FOR SELECT USING (true);



CREATE POLICY "Public can read restaurants" ON "public"."restaurants" FOR SELECT USING (true);



CREATE POLICY "Public can read settings" ON "public"."restaurant_settings" FOR SELECT USING (true);



CREATE POLICY "Public can read tables" ON "public"."restaurant_tables" FOR SELECT USING (true);



CREATE POLICY "Public can read tabs" ON "public"."tabs" FOR SELECT USING (true);



CREATE POLICY "Public can update orders" ON "public"."orders" FOR UPDATE USING (true);



CREATE POLICY "Public can update tabs" ON "public"."tabs" FOR UPDATE USING (true);



CREATE POLICY "Staff can read orders for their restaurant" ON "public"."orders" FOR SELECT TO "authenticated" USING (("restaurant_id" IN ( SELECT "staff_members"."restaurant_id"
   FROM "public"."staff_members"
  WHERE (("staff_members"."email" = ("auth"."jwt"() ->> 'email'::"text")) AND ("staff_members"."active" = true)))));



CREATE POLICY "Staff can read own permissions" ON "public"."staff_permissions" FOR SELECT TO "authenticated" USING (("staff_id" IN ( SELECT "staff_members"."id"
   FROM "public"."staff_members"
  WHERE ("staff_members"."email" = ("auth"."jwt"() ->> 'email'::"text")))));



CREATE POLICY "Staff can read own record" ON "public"."staff_members" FOR SELECT TO "authenticated" USING (("email" = ("auth"."jwt"() ->> 'email'::"text")));



CREATE POLICY "Staff can update orders for their restaurant" ON "public"."orders" FOR UPDATE TO "authenticated" USING (("restaurant_id" IN ( SELECT "staff_members"."restaurant_id"
   FROM "public"."staff_members"
  WHERE (("staff_members"."email" = ("auth"."jwt"() ->> 'email'::"text")) AND ("staff_members"."active" = true))))) WITH CHECK (("restaurant_id" IN ( SELECT "staff_members"."restaurant_id"
   FROM "public"."staff_members"
  WHERE (("staff_members"."email" = ("auth"."jwt"() ->> 'email'::"text")) AND ("staff_members"."active" = true)))));



CREATE POLICY "Staff can update own push token" ON "public"."staff_members" FOR UPDATE TO "authenticated" USING (("email" = ("auth"."jwt"() ->> 'email'::"text"))) WITH CHECK (("email" = ("auth"."jwt"() ->> 'email'::"text")));



CREATE POLICY "Staff can update own record" ON "public"."staff_members" FOR UPDATE TO "authenticated" USING (("email" = ("auth"."jwt"() ->> 'email'::"text"))) WITH CHECK (("email" = ("auth"."jwt"() ->> 'email'::"text")));



CREATE POLICY "Users can read own restaurant" ON "public"."restaurants" FOR SELECT USING (("id" IN ( SELECT "users"."restaurant_id"
   FROM "public"."users"
  WHERE ("users"."id" = "auth"."uid"()))));



CREATE POLICY "Users can read own restaurant_users row" ON "public"."restaurant_users" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can read own row" ON "public"."users" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can read own user row" ON "public"."users" FOR SELECT USING (("auth"."uid"() = "id"));



CREATE POLICY "Users can read team in their restaurant" ON "public"."restaurant_users" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."restaurant_users" "ru"
  WHERE (("ru"."user_id" = "auth"."uid"()) AND ("ru"."restaurant_id" = "restaurant_users"."restaurant_id")))));



CREATE POLICY "Users can update own row" ON "public"."users" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "anon can read orders" ON "public"."orders" FOR SELECT USING (true);



CREATE POLICY "anon read menu_items" ON "public"."menu_items" FOR SELECT TO "anon" USING (true);



ALTER TABLE "public"."audit_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."inventory_movements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."restaurant_features" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."restaurant_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."restaurant_setup_status" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."restaurant_terminals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."restaurant_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "service role can update orders" ON "public"."orders" FOR UPDATE USING (true);



ALTER TABLE "public"."staff_invites" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."staff_members" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."staff_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."table_assignments" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."orders";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."restaurants";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."table_sessions";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."tabs";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

























































































































































GRANT ALL ON FUNCTION "public"."close_table_session"("p_table_id" "uuid", "p_restaurant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."close_table_session"("p_table_id" "uuid", "p_restaurant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."close_table_session"("p_table_id" "uuid", "p_restaurant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."increment_settings_version"() TO "anon";
GRANT ALL ON FUNCTION "public"."increment_settings_version"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."increment_settings_version"() TO "service_role";



GRANT ALL ON FUNCTION "public"."notify_kitchen_on_new_order"() TO "anon";
GRANT ALL ON FUNCTION "public"."notify_kitchen_on_new_order"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."notify_kitchen_on_new_order"() TO "service_role";


















GRANT ALL ON TABLE "public"."audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."bug_reports" TO "anon";
GRANT ALL ON TABLE "public"."bug_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."bug_reports" TO "service_role";



GRANT ALL ON TABLE "public"."customer_sessions" TO "anon";
GRANT ALL ON TABLE "public"."customer_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."customer_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."daily_analytics" TO "anon";
GRANT ALL ON TABLE "public"."daily_analytics" TO "authenticated";
GRANT ALL ON TABLE "public"."daily_analytics" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_movements" TO "anon";
GRANT ALL ON TABLE "public"."inventory_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_movements" TO "service_role";



GRANT ALL ON TABLE "public"."menu_categories" TO "anon";
GRANT ALL ON TABLE "public"."menu_categories" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_categories" TO "service_role";



GRANT ALL ON TABLE "public"."menu_items" TO "anon";
GRANT ALL ON TABLE "public"."menu_items" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_items" TO "service_role";



GRANT ALL ON TABLE "public"."menu_subcategories" TO "anon";
GRANT ALL ON TABLE "public"."menu_subcategories" TO "authenticated";
GRANT ALL ON TABLE "public"."menu_subcategories" TO "service_role";



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT ALL ON TABLE "public"."orders" TO "service_role";



GRANT ALL ON TABLE "public"."payments" TO "anon";
GRANT ALL ON TABLE "public"."payments" TO "authenticated";
GRANT ALL ON TABLE "public"."payments" TO "service_role";



GRANT ALL ON TABLE "public"."restaurant_settings" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_settings" TO "service_role";



GRANT ALL ON TABLE "public"."public_restaurant_settings" TO "anon";
GRANT ALL ON TABLE "public"."public_restaurant_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."public_restaurant_settings" TO "service_role";



GRANT ALL ON TABLE "public"."restaurant_features" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_features" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_features" TO "service_role";



GRANT ALL ON TABLE "public"."restaurant_setup_status" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_setup_status" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_setup_status" TO "service_role";



GRANT ALL ON TABLE "public"."restaurant_tables" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_tables" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_tables" TO "service_role";



GRANT ALL ON TABLE "public"."restaurant_terminals" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_terminals" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_terminals" TO "service_role";



GRANT ALL ON TABLE "public"."restaurant_users" TO "anon";
GRANT ALL ON TABLE "public"."restaurant_users" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurant_users" TO "service_role";



GRANT ALL ON TABLE "public"."restaurants" TO "anon";
GRANT ALL ON TABLE "public"."restaurants" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurants" TO "service_role";



GRANT ALL ON TABLE "public"."staff_invites" TO "anon";
GRANT ALL ON TABLE "public"."staff_invites" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_invites" TO "service_role";



GRANT ALL ON TABLE "public"."staff_members" TO "anon";
GRANT ALL ON TABLE "public"."staff_members" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_members" TO "service_role";



GRANT ALL ON TABLE "public"."staff_permissions" TO "anon";
GRANT ALL ON TABLE "public"."staff_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."table_assignments" TO "anon";
GRANT ALL ON TABLE "public"."table_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."table_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."table_sessions" TO "anon";
GRANT ALL ON TABLE "public"."table_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."table_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."tabs" TO "anon";
GRANT ALL ON TABLE "public"."tabs" TO "authenticated";
GRANT ALL ON TABLE "public"."tabs" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































