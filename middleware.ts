import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Keeps the sign-in session fresh on page loads and sends signed-in people away from /login.
// Visitors can use KenBot without signing in (as guests), so nothing here blocks anyone.
// API routes are excluded below: they check who is calling themselves, which saves a network
// round trip on every chat and voice request. (On Next.js 16 this file may be called proxy.ts;
// if you see a notice about that, rename it and rename the function to `proxy`.)
export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // Only check when a sign-in cookie exists. Verifying the token locally (getClaims) avoids a
  // network call; a slow or unreachable Supabase can never block a page for more than 4 seconds.
  const hasSession = request.cookies.getAll().some((c) => c.name.startsWith("sb-"));
  let signedIn = false;
  if (hasSession) {
    const auth = supabase.auth as unknown as {
      getClaims?: () => Promise<{ data: { claims?: { sub?: string } } | null }>;
    };
    const check = async (): Promise<boolean> => {
      if (typeof auth.getClaims === "function") {
        const result = await auth.getClaims();
        return !!result?.data?.claims?.sub;
      }
      const {
        data: { user },
      } = await supabase.auth.getUser();
      return !!user;
    };
    try {
      signedIn = await Promise.race([
        check(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4000)),
      ]);
    } catch {
      signedIn = false;
    }
  }

  if (signedIn && request.nextUrl.pathname.startsWith("/login")) {
    const to = request.nextUrl.clone();
    to.pathname = "/";
    to.search = "";
    return NextResponse.redirect(to);
  }

  return response;
}

export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|.*\\.(?:png|jpg|jpeg|webp|svg|ico)$).*)"],
};
