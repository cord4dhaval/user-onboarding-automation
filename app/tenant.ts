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
