import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;

  // Both variables must be set for the shortcut to appear, so a deployment with real
  // customer data turns it off by not setting them rather than by remembering to strip code.
  const email = process.env.DEMO_EMAIL;
  const password = process.env.DEMO_PASSWORD;
  const demo = email && password ? { email, password } : undefined;

  return (
    <main className="auth">
      <h1>Sign in</h1>
      <p className="sub">Conversion Engine</p>
      <LoginForm next={next ?? "/products"} demo={demo} />
      <p className="sub" style={{ marginTop: 20 }}>
        No account? <a href="/signup">Create one</a>
      </p>
    </main>
  );
}
