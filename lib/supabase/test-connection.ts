import { createServerSupabaseClient } from "./server";

export async function testSupabaseConnection() {
  const supabase = createServerSupabaseClient();
  const { data, error } = await supabase.from("restaurants").select("count");

  if (error) {
    console.error("Supabase connection failed:", error);
    return false;
  }

  console.log("Supabase connected successfully", data);
  return true;
}
