import { ObjectId } from "mongodb";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";

/** Single organisation until login lands. Product, however, is explicit everywhere. */
export const ORG_ID = "000000000000000000000001";

export async function getProduct(productId: string) {
  const db = await getDb();
  return db.collection(C.products).findOne({ _id: new ObjectId(productId), orgId: ORG_ID });
}

/**
 * Scope object used by every product-level query. Nothing reads an ambient "current
 * product" — with several products under one account, ambient state eventually means one
 * product's copy reaching another product's leads.
 */
export function scope(productId: string) {
  return { orgId: ORG_ID, productId };
}
