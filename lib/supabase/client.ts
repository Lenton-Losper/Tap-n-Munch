import { createClient } from "@supabase/supabase-js";

let _supabase: ReturnType<typeof createClient> | null = null;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();

export function getSupabaseClient() {
  if (!_supabase) {
    _supabase = createClient(supabaseUrl, supabaseAnonKey);
  }
  return _supabase;
}

export const supabase = getSupabaseClient();
