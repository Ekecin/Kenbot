"use client";

import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("invalid login")) return "That email and password don't match. Double-check them and try again.";
  if (m.includes("already registered") || m.includes("already been registered"))
    return "That email already has an account. Try signing in instead.";
  if (m.includes("email not confirmed")) return "Please confirm your email first. Check your inbox for the link.";
  if (m.includes("at least") && m.includes("character")) return "Please choose a password with at least 6 characters.";
  if (m.includes("rate limit") || m.includes("too many"))
    return "Too many attempts. Please wait a minute and try again.";
  if (m.includes("valid email")) return "That email address doesn't look right. Please check it.";
  return "Something went wrong. Please try again.";
}

export default function AuthForm({ initialError }: { initialError?: string }) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);

  const [mode, setMode] = useState<"in" | "up">("in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [info, setInfo] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      if (mode === "in") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          setError(friendlyAuthError(error.message));
          return;
        }
        router.replace("/");
        router.refresh();
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: name.trim() || undefined },
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });
        if (error) {
          setError(friendlyAuthError(error.message));
          return;
        }
        if (data.session) {
          router.replace("/");
          router.refresh();
        } else {
          setInfo("Almost there! Check your email for a confirmation link, then come back and sign in. 💜");
        }
      }
    } catch {
      setError("I couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Sign in or create an account">
        <button type="button" role="tab" aria-selected={mode === "in"} onClick={() => setMode("in")}>
          Sign in
        </button>
        <button type="button" role="tab" aria-selected={mode === "up"} onClick={() => setMode("up")}>
          Create account
        </button>
      </div>

      {error && (
        <p className="auth-msg error" role="alert">
          {error}
        </p>
      )}
      {info && (
        <p className="auth-msg info" role="status">
          {info}
        </p>
      )}

      <form onSubmit={onSubmit}>
        {mode === "up" && (
          <label>
            What should I call you?
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="given-name"
              placeholder="Your name"
              maxLength={40}
            />
          </label>
        )}
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            placeholder={mode === "up" ? "At least 6 characters" : "Your password"}
            minLength={6}
            required
          />
        </label>
        <button type="submit" className="submit" disabled={busy}>
          {busy ? "One moment…" : mode === "in" ? "Sign in" : "Create my account"}
        </button>
      </form>
    </>
  );
}
