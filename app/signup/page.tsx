import SignUpForm from "./signup-form";

export default function SignUp() {
  return (
    <main className="auth">
      <h1>Create an account</h1>
      <p className="sub">You get a workspace of your own; everything you add lives inside it.</p>
      <SignUpForm />
      <p className="sub" style={{ marginTop: 20 }}>
        Already have one? <a href="/login">Sign in</a>
      </p>
    </main>
  );
}
