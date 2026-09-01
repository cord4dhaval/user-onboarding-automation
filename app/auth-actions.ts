"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authenticate, createAccount, AuthError } from "@/auth/accounts.js";
import { signSession } from "@/auth/session.js";
import { SESSION_COOKIE } from "./tenant";

export interface FormState {
  error?: string;
  /** Which field to focus and mark invalid, when the failure points at one. */
  field?: "email" | "password" | "name" | "orgName";
  /**
   * React resets an uncontrolled form once its action returns, so what the person typed
   * comes back with the error and is re-seeded as defaultValue. Passwords are left out.
   */
  values?: { email?: string; name?: string; orgName?: string };
}

async function startSession(payload: { userId: string; orgId: string; email: string }) {
  (await cookies()).set(SESSION_COOKIE, signSession(payload), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

/** Only same-site paths, so a crafted ?next= cannot bounce a fresh session off to another host. */
function safeNext(value: FormDataEntryValue | null): string {
  const next = String(value ?? "");
  return next.startsWith("/") && !next.startsWith("//") ? next : "/products";
}

/**
 * Turns whatever escaped an auth call into something worth reading. AuthError messages are
 * written for the person at the form; everything else is a fault on our side, and the
 * detail belongs in the server log rather than in the page.
 */
function toFormState(err: unknown, values: FormState["values"]): FormState {
  if (err instanceof AuthError || (err instanceof Error && err.name === "AuthError")) {
    return { error: err.message, field: fieldFor(err.message), values };
  }
  console.error("[auth] unexpected failure", err);
  return { error: "Something went wrong on our end. Try again in a moment.", values };
}

function fieldFor(message: string): FormState["field"] {
  if (/password/i.test(message)) return "password";
  if (/email/i.test(message)) return "email";
  return undefined;
}

export async function signUp(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = {
    email: String(formData.get("email") ?? ""),
    name: String(formData.get("name") ?? ""),
    orgName: String(formData.get("orgName") ?? ""),
  };
  try {
    const account = await createAccount({
      ...values,
      password: String(formData.get("password") ?? ""),
    });
    await startSession(account);
  } catch (err) {
    return toFormState(err, values);
  }
  // Outside the catch: redirect() signals by throwing, and swallowing that would strand the
  // caller on the form with no error to show.
  redirect("/products");
}

export async function logIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const values = { email };
  if (!email) return { error: "Enter your email address", field: "email", values };
  if (!password) return { error: "Enter your password", field: "password", values };

  try {
    const account = await authenticate(email, password);
    // One message for both wrong-email and wrong-password, so the form cannot be used to
    // discover which addresses have accounts.
    if (!account) return { error: "Email or password is incorrect", field: "password", values };
    await startSession(account);
  } catch (err) {
    return toFormState(err, values);
  }
  redirect(safeNext(formData.get("next")));
}

export async function logOut() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
