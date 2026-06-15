import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })
dotenv.config({ path: '.env' })

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(url, key)

async function enableOrdersRealtime() {
  const sql = `
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'orders'
      ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE orders;
      END IF;
    END $$;
  `

  const { error } = await supabase.rpc('exec_sql', { sql })
  if (error) {
    console.log('exec_sql RPC unavailable — run this in the Supabase SQL editor:')
    console.log(`ALTER PUBLICATION supabase_realtime ADD TABLE orders;`)
    console.error(error)
    process.exit(1)
  }

  console.log('✅ orders table added to supabase_realtime publication')
}

enableOrdersRealtime().catch(console.error)
