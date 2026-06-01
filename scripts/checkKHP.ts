import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://ihlmmpmolnpchzgwyhgh.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlobG1tcG1vbG5wY2h6Z3d5aGdoIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Njg3NDcwMCwiZXhwIjoyMDkyNDUwNzAwfQ.lTlLVVazNXYuLz0YNnhERkyZG9m9G7FOAStj5Xm5WnM'
)

async function check() {
  const { data: users, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', 'flashtapapp2@gmail.com')
  
  console.log('Users found:', users)
  console.log('Error:', error)
}

check().catch(console.error)
