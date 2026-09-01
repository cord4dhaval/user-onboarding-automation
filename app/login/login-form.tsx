"use client";

import { useActionState, useRef } from "react";
import { useFormStatus } from "react-dom";
import { logIn } from "../auth-actions";
import type { FormState } from "../auth-actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

export interface DemoAccount {
  email: string;
  password: string;
}

export default function LoginForm({ next, demo }: { next: string; demo?: DemoAccount }) {
  const [state, action] = useActionState<FormState, FormData>(logIn, {});
  const formRef = useRef<HTMLFormElement>(null);

  /** Fills the visible fields and submits, so the demo path is the ordinary path. */
  function useDemo() {
    const form = formRef.current;
    if (!form || !demo) return;
    (form.elements.namedItem("email") as HTMLInputElement).value = demo.email;
    (form.elements.namedItem("password") as HTMLInputElement).value = demo.password;
    form.requestSubmit();
  }

  return (
    <>
      <form ref={formRef} action={action} className="stack" noValidate>
        {state.error && (
          <p className="form-error" role="alert" aria-live="polite">
            {state.error}
          </p>
        )}
        <input type="hidden" name="next" value={next} />
        <label>
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            defaultValue={state.values?.email ?? ""}
            aria-invalid={state.field === "email" || undefined}
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            aria-invalid={state.field === "password" || undefined}
          />
        </label>
        <Submit />
      </form>

      {demo && (
        <div className="card demo-card">
          <div className="label">Demo account</div>
          <table>
            <tbody>
              <tr>
                <th>Email</th>
                <td><code>{demo.email}</code></td>
              </tr>
              <tr>
                <th>Password</th>
                <td><code>{demo.password}</code></td>
              </tr>
            </tbody>
          </table>
          <button type="button" className="ghost" onClick={useDemo} style={{ marginTop: 10 }}>
            Fill and sign in
          </button>
        </div>
      )}
    </>
  );
}
