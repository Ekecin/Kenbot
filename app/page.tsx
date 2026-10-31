import Chat from "@/components/Chat";
import { createClient } from "@/lib/supabase/server";

export default async function Page() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // No account? No problem. They can chat as a guest, just without saved history.
  if (!user) return <Chat userName={null} email={null} />;

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", user.id)
    .maybeSingle();

  const name: string =
    profile?.display_name ||
    user.user_metadata?.display_name ||
    user.email?.split("@")[0] ||
    "friend";

  return <Chat userName={name} email={user.email ?? ""} />;
}
