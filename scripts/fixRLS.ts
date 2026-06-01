import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://ihlmmpmolnpchzgwyhgh.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlobG1tcG1vbG5wY2h6Z3d5aGdoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njg3NDcwMCwiZXhwIjoyMDkyNDUwNzAwfQ.lTlLVVazNXYuLz0YNnhERkyZG9m9G7FOAStj5Xm5WnM'
)

async function fixRLS() {
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
