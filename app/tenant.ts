import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ObjectId } from "mongodb";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { verifySession, type SessionPayload } from "@/auth/session.js";

export const SESSION_COOKIE = "ce_session";

export async function currentSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value);
}

/** Every page and action behind the login wall goes through this. */
export async function requireSession(): Promise<SessionPayload> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}

export async function getProduct(productId: string, orgId: string) {
  const db = await getDb();
  // Scoped by org, so a guessed product id from another tenant simply does not exist.
  return db.collection(C.products).findOne({ _id: new ObjectId(productId), orgId });
}

/** The scope object every product-level query is built from. */
export function scope(orgId: string, productId: string) {
  return { orgId, productId };
}

/**
 * The identity behind the avatar. The session cookie carries only ids and an email, so the
 * display name comes from the user record; a missing one falls back to the email's local
 * part rather than leaving the menu headed by nothing.
 */
export async function getAccount(session: SessionPayload): Promise<{ name: string; email: string; orgName: string }> {
  const db = await getDb();
  const [user, org] = await Promise.all([
    db.collection(C.users).findOne({ _id: new ObjectId(session.userId) }),
    db.collection(C.organizations).findOne({ _id: new ObjectId(session.orgId) }),
  ]);
  return {
    name: String(user?.name || session.email.split("@")[0]),
    email: session.email,
    orgName: String(org?.name || ""),
  };
}
