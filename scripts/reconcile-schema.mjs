#!/usr/bin/env node
/**
 * Reconcile supabase/schema.sql: main's full dump + staging migration end-states.
 * Run from repo root after checking out main's schema.sql as the structural base.
 */
import fs from 'fs'

const path = 'supabase/schema.sql'
let sql = fs.readFileSync(path, 'utf8')

if (!sql.includes('"base_unit"')) {
  console.error('Expected main schema with base_unit on stock_items — aborting')
  process.exit(1)
}

// 1. menu_items extended fields + track_inventory (staging migrations)
sql = sql.replace(
  `    "firebase_restaurant_id" "text",
    "is_popular" boolean DEFAULT false NOT NULL
);`,
  `    "firebase_restaurant_id" "text",
    "is_popular" boolean DEFAULT false NOT NULL,
    "image_fit" "text" DEFAULT 'contain'::"text" NOT NULL,
    "image_position" "text" DEFAULT 'center'::"text" NOT NULL,
    "allow_special_instructions" boolean DEFAULT true NOT NULL,
    "has_sizes" boolean DEFAULT false NOT NULL,
    "sizes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "has_addons" boolean DEFAULT false NOT NULL,
    "addons" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "track_inventory" boolean DEFAULT false NOT NULL
);`,
)

// 2. measurement_units table (before stock_items)
const measurementUnitsTable = `
--
-- Name: measurement_units; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."measurement_units" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid",
    "name" "text" NOT NULL,
    "symbol" "text",
    "is_system" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "measurement_units_restaurant_id_name_key" UNIQUE ("restaurant_id", "name")
);


ALTER TABLE "public"."measurement_units" OWNER TO "postgres";

`

sql = sql.replace(
  `--
-- Name: stock_items; Type: TABLE; Schema: public; Owner: postgres
--`,
  `${measurementUnitsTable}--
-- Name: stock_items; Type: TABLE; Schema: public; Owner: postgres
--`,
)

// 3. stock_items: unit_id replaces base_unit
sql = sql.replace(
  `    "base_unit" "text" NOT NULL,`,
  `    "unit_id" "uuid" NOT NULL,`,
)

// 4. recipes + recipe_items (after stock_movements)
const recipeTables = `
--
-- Name: recipes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."recipes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "restaurant_id" "uuid" NOT NULL,
    "menu_item_id" "uuid" NOT NULL,
    "name" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "recipes_restaurant_id_menu_item_id_key" UNIQUE ("restaurant_id", "menu_item_id")
);


ALTER TABLE "public"."recipes" OWNER TO "postgres";

--
-- Name: recipe_items; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE IF NOT EXISTS "public"."recipe_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "recipe_id" "uuid" NOT NULL,
    "stock_item_id" "uuid" NOT NULL,
    "quantity" numeric NOT NULL,
    "unit_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "recipe_items_quantity_check" CHECK (("quantity" > (0)::numeric))
);


ALTER TABLE "public"."recipe_items" OWNER TO "postgres";

`

sql = sql.replace(
  `ALTER TABLE "public"."stock_movements" OWNER TO "postgres";

--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: postgres
--`,
  `ALTER TABLE "public"."stock_movements" OWNER TO "postgres";
${recipeTables}
--
-- Name: subscriptions; Type: TABLE; Schema: public; Owner: postgres
--`,
)

// 5. deduct_recipe_stock function + trigger
const recipeFunctions = `
--
-- Name: deduct_recipe_stock(uuid); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."deduct_recipe_stock"("p_order_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
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
$$;


ALTER FUNCTION "public"."deduct_recipe_stock"("p_order_id" "uuid") OWNER TO "postgres";

--
-- Name: trg_order_completion_deducts_stock(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE OR REPLACE FUNCTION "public"."trg_order_completion_deducts_stock"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    PERFORM "public"."deduct_recipe_stock"(NEW.id);
    RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trg_order_completion_deducts_stock"() OWNER TO "postgres";

`

sql = sql.replace(
  `ALTER FUNCTION "public"."create_movement_from_goods_received_item"() OWNER TO "postgres";`,
  `ALTER FUNCTION "public"."create_movement_from_goods_received_item"() OWNER TO "postgres";
${recipeFunctions}`,
)

// 6. Primary keys
sql = sql.replace(
  `ALTER TABLE ONLY "public"."menu_subcategories"
    ADD CONSTRAINT "menu_subcategories_pkey" PRIMARY KEY ("id");`,
  `ALTER TABLE ONLY "public"."menu_subcategories"
    ADD CONSTRAINT "menu_subcategories_pkey" PRIMARY KEY ("id");


--
-- Name: measurement_units measurement_units_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."measurement_units"
    ADD CONSTRAINT "measurement_units_pkey" PRIMARY KEY ("id");`,
)

sql = sql.replace(
  `ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");`,
  `ALTER TABLE ONLY "public"."payments"
    ADD CONSTRAINT "payments_pkey" PRIMARY KEY ("id");


--
-- Name: recipe_items recipe_items_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."recipe_items"
    ADD CONSTRAINT "recipe_items_pkey" PRIMARY KEY ("id");


--
-- Name: recipes recipes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."recipes"
    ADD CONSTRAINT "recipes_pkey" PRIMARY KEY ("id");`,
)

// 7. Indexes
sql = sql.replace(
  `CREATE INDEX "idx_stock_items_restaurant" ON "public"."stock_items" USING "btree" ("restaurant_id");`,
  `CREATE INDEX "idx_measurement_units_restaurant" ON "public"."measurement_units" USING "btree" ("restaurant_id");


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

CREATE INDEX "idx_stock_items_unit" ON "public"."stock_items" USING "btree" ("unit_id");`,
)

// 8. Trigger on orders
sql = sql.replace(
  `CREATE OR REPLACE TRIGGER "trg_goods_received_items_creates_movement" AFTER INSERT ON "public"."goods_received_items" FOR EACH ROW EXECUTE FUNCTION "public"."create_movement_from_goods_received_item"();`,
  `CREATE OR REPLACE TRIGGER "trg_goods_received_items_creates_movement" AFTER INSERT ON "public"."goods_received_items" FOR EACH ROW EXECUTE FUNCTION "public"."create_movement_from_goods_received_item"();


--
-- Name: orders trg_order_completion_deducts_stock; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE OR REPLACE TRIGGER "trg_order_completion_deducts_stock" AFTER UPDATE OF "status" ON "public"."orders" FOR EACH ROW WHEN ((("new"."status" = 'completed'::"text") AND ("old"."status" IS DISTINCT FROM 'completed'::"text"))) EXECUTE FUNCTION "public"."trg_order_completion_deducts_stock"();`,
)

// 9. Foreign keys
sql = sql.replace(
  `ALTER TABLE ONLY "public"."stock_items"
    ADD CONSTRAINT "stock_items_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;`,
  `ALTER TABLE ONLY "public"."measurement_units"
    ADD CONSTRAINT "measurement_units_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: recipe_items recipe_items_recipe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."recipe_items"
    ADD CONSTRAINT "recipe_items_recipe_id_fkey" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE CASCADE;


--
-- Name: recipe_items recipe_items_stock_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."recipe_items"
    ADD CONSTRAINT "recipe_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE RESTRICT;


--
-- Name: recipe_items recipe_items_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."recipe_items"
    ADD CONSTRAINT "recipe_items_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."measurement_units"("id") ON DELETE RESTRICT;


--
-- Name: recipes recipes_menu_item_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."recipes"
    ADD CONSTRAINT "recipes_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE CASCADE;


--
-- Name: recipes recipes_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."recipes"
    ADD CONSTRAINT "recipes_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: stock_items stock_items_restaurant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."stock_items"
    ADD CONSTRAINT "stock_items_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE CASCADE;


--
-- Name: stock_items stock_items_unit_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY "public"."stock_items"
    ADD CONSTRAINT "stock_items_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "public"."measurement_units"("id") ON DELETE RESTRICT;`,
)

// 10. Policies
sql = sql.replace(
  `CREATE POLICY "Owners can manage own restaurant stock items" ON "public"."stock_items" USING (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids"))) WITH CHECK (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")));`,
  `CREATE POLICY "Authenticated users can read system measurement units" ON "public"."measurement_units" FOR SELECT TO "authenticated" USING (("restaurant_id" IS NULL));


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

CREATE POLICY "Owners can manage own restaurant stock items" ON "public"."stock_items" USING (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids"))) WITH CHECK (("restaurant_id" IN ( SELECT "public"."user_restaurant_ids"() AS "user_restaurant_ids")));`,
)

// 11. RLS enables
sql = sql.replace(
  `ALTER TABLE "public"."menu_items" ENABLE ROW LEVEL SECURITY;`,
  `ALTER TABLE "public"."measurement_units" ENABLE ROW LEVEL SECURITY;

--
-- Name: menu_items; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."menu_items" ENABLE ROW LEVEL SECURITY;`,
)

sql = sql.replace(
  `ALTER TABLE "public"."report_send_log" ENABLE ROW LEVEL SECURITY;`,
  `ALTER TABLE "public"."recipe_items" ENABLE ROW LEVEL SECURITY;

--
-- Name: recipes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."recipes" ENABLE ROW LEVEL SECURITY;

--
-- Name: report_send_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE "public"."report_send_log" ENABLE ROW LEVEL SECURITY;`,
)

// 12. ACL grants (minimal — match stock_items pattern)
sql = sql.replace(
  `GRANT ALL ON TABLE "public"."menu_items" TO "service_role";`,
  `GRANT ALL ON TABLE "public"."menu_items" TO "service_role";


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
GRANT ALL ON TABLE "public"."recipes" TO "service_role";`,
)

sql = sql.replace(
  `GRANT ALL ON FUNCTION "public"."create_movement_from_goods_received_item"() TO "service_role";`,
  `GRANT ALL ON FUNCTION "public"."create_movement_from_goods_received_item"() TO "service_role";


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
GRANT ALL ON FUNCTION "public"."trg_order_completion_deducts_stock"() TO "service_role";`,
)

// Verify no base_unit left in schema dump
if (/\bbase_unit\b/.test(sql)) {
  console.error('ERROR: base_unit still present after reconciliation')
  process.exit(1)
}

fs.writeFileSync(path, sql)
console.log('Reconciled', path)
console.log('  - measurement_units table added')
console.log('  - stock_items.base_unit -> unit_id')
console.log('  - recipes + recipe_items tables added')
console.log('  - menu_items extended fields + track_inventory added')
console.log('  - deduct_recipe_stock function + trigger added')
console.log('  - orders RLS policies preserved from main (Staff + Guest, no Public update)')
