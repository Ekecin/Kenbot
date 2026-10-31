import { createBrowserClient } from "@supabase/ssr";

// Runs in the browser. Uses the public "anon" (or "publishable") key,
// which is safe to expose because Row Level Security protects the data.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
