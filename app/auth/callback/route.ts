import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Where the email-confirmation link lands. Swaps the one-time code
// for a signed-in session, then sends the person to the chat.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/`);
  }

  return NextResponse.redirect(`${origin}/login?error=confirm`);
}
