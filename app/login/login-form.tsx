"use client";

import { useActionState } from "react";
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

export default function LoginForm({ next }: { next: string }) {
  const [state, action] = useActionState<FormState, FormData>(logIn, {});

  return (
    <form action={action} className="stack" noValidate>
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
  );
}
