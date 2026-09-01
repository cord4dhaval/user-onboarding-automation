import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="auth">
      <h1>Sign in</h1>
      <p className="sub">Conversion Engine</p>
      <LoginForm next={next ?? "/products"} />
      <p className="sub" style={{ marginTop: 20 }}>
        No account? <a href="/signup">Create one</a>
      </p>
    </main>
  );
}
