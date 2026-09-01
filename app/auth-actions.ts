"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authenticate, createAccount } from "@/auth/accounts.js";
import { signSession } from "@/auth/session.js";
import { SESSION_COOKIE } from "./tenant";

async function startSession(payload: { userId: string; orgId: string; email: string }) {
  (await cookies()).set(SESSION_COOKIE, signSession(payload), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function signUp(formData: FormData) {
  const account = await createAccount({
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    name: String(formData.get("name") ?? ""),
    orgName: String(formData.get("orgName") ?? ""),
  });
  await startSession(account);
  redirect("/products");
}

export async function logIn(formData: FormData) {
  const account = await authenticate(String(formData.get("email") ?? ""), String(formData.get("password") ?? ""));
  // One message for both wrong-email and wrong-password, so the form cannot be used to
  // discover which addresses have accounts.
  if (!account) throw new Error("Email or password is incorrect");
  await startSession(account);
  redirect(String(formData.get("next") ?? "/products"));
}

export async function logOut() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
