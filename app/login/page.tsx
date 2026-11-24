import Image from "next/image";
import Link from "next/link";
import AuthForm from "@/components/AuthForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="shell auth-shell">
      <section className="auth" aria-label="Sign in to KenBot">
        <div className="avatar">
          <Image src="/avatar.webp" alt="" width={64} height={64} priority />
        </div>
        <h1>Welcome to KenBot</h1>
        <p className="auth-sub">
          Sign in to pick up your conversations right where you left off.
        </p>
        <AuthForm
          initialError={
            error === "confirm"
              ? "That confirmation link didn't work or has expired. Try signing in, or create your account again."
              : undefined
          }
        />
        <Link href="/" className="guest-link">
          Continue as guest
        </Link>
        <p className="guest-hint">Guests can chat freely, but conversations aren&apos;t saved.</p>
      </section>
    </main>
  );
}
