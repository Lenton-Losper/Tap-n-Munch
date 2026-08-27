/**
 * Apply baseline RLS policies through the `exec_sql` RPC.
 *
 * The production `service_role` key was a string literal in this file until 2026-08-27. It now
 * comes from the environment via scripts/lib/require-service-role-client.ts, which STOPS if the
 * variable is absent rather than continuing with an empty key. See that file for the reasoning.
 *
 * This script WRITES (it alters tables and replaces policies), so it names the environment it is
 * about to act on before doing anything.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/fixRLS.ts
 */
import { requireServiceRoleClient } from './lib/require-service-role-client'

const { client: supabase, environment, projectRef } = requireServiceRoleClient()

async function fixRLS() {
  console.log(`fixRLS: applying policies to ${environment} (${projectRef})`)
  // Enable RLS and add policy so users can read their own row
  const { error } = await supabase.rpc('exec_sql', {
    sql: `
      ALTER TABLE users ENABLE ROW LEVEL SECURITY;
      
      DROP POLICY IF EXISTS "Users can read own row" ON users;
      CREATE POLICY "Users can read own row" ON users
        FOR SELECT USING (auth.uid() = id);

      DROP POLICY IF EXISTS "Users can update own row" ON users;  
      CREATE POLICY "Users can update own row" ON users
        FOR UPDATE USING (auth.uid() = id);

      ALTER TABLE restaurants ENABLE ROW LEVEL SECURITY;

      DROP POLICY IF EXISTS "Users can read own restaurant" ON restaurants;
      CREATE POLICY "Users can read own restaurant" ON restaurants
        FOR SELECT USING (
          id IN (SELECT restaurant_id FROM users WHERE id = auth.uid())
        );

      ALTER TABLE menu_categories ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "Public can read menu categories" ON menu_categories;
      CREATE POLICY "Public can read menu categories" ON menu_categories
        FOR SELECT USING (true);

      ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "Public can read menu items" ON menu_items;
      CREATE POLICY "Public can read menu items" ON menu_items
        FOR SELECT USING (true);

      ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "Public can insert orders" ON orders;
      CREATE POLICY "Public can insert orders" ON orders
        FOR INSERT WITH CHECK (true);
      DROP POLICY IF EXISTS "Users can read own restaurant orders" ON orders;
      CREATE POLICY "Users can read own restaurant orders" ON orders
        FOR SELECT USING (true);
      DROP POLICY IF EXISTS "Users can update orders" ON orders;
      CREATE POLICY "Users can update orders" ON orders
        FOR UPDATE USING (true);
    `
  })
  
  if (error) {
    console.log('RPC not available, please run the SQL manually in Supabase SQL editor')
    console.log(error)
  } else {
    console.log('✅ RLS policies applied successfully')
  }
}

fixRLS().catch(console.error)
