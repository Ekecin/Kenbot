import { cookies } from "next/headers";
import type { createClient } from "@/lib/supabase/server";

type SupabaseServer = Awaited<ReturnType<typeof createClient>>;

export type Identity = { userId: string | null; name: string; email: string | null };

const GUEST: Identity = { userId: null, name: "", email: null };

function cleanName(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/g, " ").trim().slice(0, 40) : "";
}

/**
 * Who is calling? Signed-out visitors (no Supabase cookie) are identified with zero network calls.
 * For signed-in people the access token is verified locally when the project uses asymmetric
 * signing keys (getClaims), which is much faster than asking Supabase Auth on every request;
 * otherwise it falls back to getUser(). The display name comes straight from the token, so no
 * database query is needed to personalise a reply.
 */
export async function getIdentity(supabase: SupabaseServer): Promise<Identity> {
  try {
    const store = await cookies();
    if (!store.getAll().some((c) => c.name.startsWith("sb-"))) return GUEST;

    const auth = supabase.auth as unknown as {
      getClaims?: () => Promise<{ data: { claims?: Record<string, unknown> } | null; error: unknown }>;
    };
    if (typeof auth.getClaims === "function") {
      const { data, error } = await auth.getClaims();
      const claims = data?.claims;
      if (!error && claims && typeof claims.sub === "string") {
        const email = typeof claims.email === "string" ? claims.email : null;
        const meta = (claims.user_metadata ?? {}) as Record<string, unknown>;
        return { userId: claims.sub, email, name: cleanName(meta.display_name) || cleanName(email?.split("@")[0]) };
      }
      if (!error && !claims) return GUEST;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return GUEST;
    const email = user.email ?? null;
    return {
      userId: user.id,
      email,
      name: cleanName(user.user_metadata?.display_name) || cleanName(email?.split("@")[0]),
    };
  } catch {
    return GUEST;
  }
}

/** Best-effort network address, used only for guest rate limits. */
export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown";
}
