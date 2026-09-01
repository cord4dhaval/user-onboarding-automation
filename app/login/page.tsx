import { logIn } from "../auth-actions";

export const dynamic = "force-dynamic";

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="auth">
      <h1>Sign in</h1>
      <p className="sub">Conversion Engine</p>
      <form action={logIn} className="stack">
        <input type="hidden" name="next" value={next ?? "/products"} />
        <label>Email<input name="email" type="email" autoComplete="email" required autoFocus /></label>
        <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
        <button type="submit">Sign in</button>
      </form>
      <p className="sub" style={{ marginTop: 20 }}>
        No account? <a href="/signup">Create one</a>
      </p>
    </main>
  );
}
