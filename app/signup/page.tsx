import { signUp } from "../auth-actions";

export default function SignUp() {
  return (
    <main className="auth">
      <h1>Create an account</h1>
      <p className="sub">You get a workspace of your own; everything you add lives inside it.</p>
      <form action={signUp} className="stack">
        <label>Your name<input name="name" autoComplete="name" /></label>
        <label>Workspace name<input name="orgName" placeholder="Acme" /></label>
        <label>Email<input name="email" type="email" autoComplete="email" required /></label>
        <label>
          Password <span className="muted">(at least 8 characters)</span>
          <input name="password" type="password" autoComplete="new-password" minLength={8} required />
        </label>
        <button type="submit">Create account</button>
      </form>
      <p className="sub" style={{ marginTop: 20 }}>
        Already have one? <a href="/login">Sign in</a>
      </p>
    </main>
  );
}
