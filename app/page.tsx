import Chat from "@/components/Chat";
import { getIdentity } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type { TtsProviderId } from "@/lib/tts";

// Depends on the visitor's cookies, so it must be rendered per request, never at build time.
export const dynamic = "force-dynamic";

export default async function Page() {
  const supabase = await createClient();
  const identity = await getIdentity(supabase);

  // Neural voice needs the server-side Gemini key; without it the built-in browser voice is used.
  const ttsProvider: TtsProviderId =
    process.env.TTS_PROVIDER?.toLowerCase() === "browser" || !process.env.GEMINI_API_KEY ? "browser" : "gemini";
  // Timings panel and console tables: development, or set VOICE_DEBUG=1.
  const debug = process.env.NODE_ENV !== "production" || process.env.VOICE_DEBUG === "1";

  // No account? No problem. They can chat as a guest, just without saved history.
  if (!identity.userId) {
    return <Chat userName={null} email={null} ttsProvider={ttsProvider} debug={debug} />;
  }

  return (
    <Chat
      userName={identity.name || "friend"}
      email={identity.email ?? ""}
      ttsProvider={ttsProvider}
      debug={debug}
    />
  );
}
