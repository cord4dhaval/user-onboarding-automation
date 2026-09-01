"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { signUp } from "../auth-actions";
import type { FormState } from "../auth-actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Creating account…" : "Create account"}
    </button>
  );
}

export default function SignUpForm() {
  const [state, action] = useActionState<FormState, FormData>(signUp, {});

  return (
    <form action={action} className="stack" noValidate>
      {state.error && (
        <p className="form-error" role="alert" aria-live="polite">
          {state.error}
        </p>
      )}
      <label>Your name<input name="name" autoComplete="name" defaultValue={state.values?.name ?? ""} /></label>
      <label>Workspace name<input name="orgName" placeholder="Acme" defaultValue={state.values?.orgName ?? ""} /></label>
      <label>
        Email
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state.values?.email ?? ""}
          aria-invalid={state.field === "email" || undefined}
        />
      </label>
      <label>
        Password <span className="muted">(at least 8 characters)</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          aria-invalid={state.field === "password" || undefined}
        />
      </label>
      <Submit />
    </form>
  );
}
