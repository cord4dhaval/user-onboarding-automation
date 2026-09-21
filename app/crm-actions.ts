"use server";

import { ObjectId } from "mongodb";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { ensureIndexes } from "@/db/indexes.js";
import { reverifyConnection } from "@/mcp/reverify.js";
import { crmMap } from "@/schemas/crm.js";
import { CrmClient } from "@/engine/crm/client.js";
import { proposeCrmMap } from "@/engine/crm/map.js";
import { lockConnection, syncPerson, unlockConnection } from "@/engine/crm/sync.js";
import { requireSession } from "./tenant";

/**
 * Switching a CRM on, off, and pointing it at the right tenant and projects.
 *
 * Kept apart from the rest of the console's actions because none of it touches sending: a
 * CRM connection only ever reads, and every one of these can be undone by the next.
 */

async function ownedConnection(connectionId: string) {
  const { orgId } = await requireSession();
  if (!ObjectId.isValid(connectionId)) throw new Error("not a connection");
  const db = await getDb();
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId), orgId });
  if (!connection) throw new Error("connection not found");
  return { db, orgId, connection };
}

const connectionPath = (productId: string, connectionId: string) =>
  `/products/${productId}/connections/${connectionId}`;

/** Re-reads the tools and drafts a map from them. Nothing is read from the CRM until it is switched on. */
export async function proposeCrm(productId: string, connectionId: string, _formData?: FormData) {
  const { db, orgId, connection } = await ownedConnection(connectionId);
  const found = await reverifyConnection(orgId, connectionId);
  if (found.error) throw new Error(found.error);
  const existing = crmMap.safeParse(connection.crm?.map);
  const draft = proposeCrmMap(found.tools, existing.success ? existing.data.scope : {});
  if (!draft) throw new Error("This connection's tools do not look like a CRM: there is no tool to find a lead and none that lists its history.");
  const map = existing.success ? { ...draft, scope: existing.data.scope, projects: existing.data.projects } : draft;
  await db
    .collection(C.connections)
    .updateOne({ _id: connection._id }, { $set: { "crm.map": map, "crm.proposedAt": new Date() } });
  revalidatePath(connectionPath(productId, connectionId));
}

/** Saves the tenant, the projects and, when given, a hand-edited map. */
export async function saveCrmSettings(formData: FormData) {
  const productId = String(formData.get("productId"));
  const connectionId = String(formData.get("connectionId"));
  const { db, connection } = await ownedConnection(connectionId);

  const rawMap = String(formData.get("map") ?? "").trim();
  let base: unknown = connection.crm?.map;
  if (rawMap) {
    try {
      base = JSON.parse(rawMap);
    } catch {
      throw new Error("The map is not valid JSON.");
    }
  }
  const scopeRaw = String(formData.get("scope") ?? "").trim();
  let scope: Record<string, unknown> | undefined;
  if (scopeRaw) {
    try {
      scope = JSON.parse(scopeRaw) as Record<string, unknown>;
    } catch {
      throw new Error("The tenant settings are not valid JSON, for example {\"orgId\": \"…\"}.");
    }
  }
  const projects = String(formData.get("projects") ?? "")
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const parsed = crmMap.safeParse({ ...(base as object), ...(scope ? { scope } : {}), projects });
  if (!parsed.success) {
    throw new Error(`The map is incomplete: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  await db.collection(C.connections).updateOne({ _id: connection._id }, { $set: { "crm.map": parsed.data } });
  revalidatePath(connectionPath(productId, connectionId));
}

export async function setCrmEnabled(productId: string, connectionId: string, enabled: boolean, _formData?: FormData) {
  const { db, connection } = await ownedConnection(connectionId);
  if (enabled && !crmMap.safeParse(connection.crm?.map).success) throw new Error("Set up the CRM map first.");
  if (enabled) await ensureIndexes();
  await db.collection(C.connections).updateOne(
    { _id: connection._id },
    {
      $set: {
        "crm.enabled": enabled,
        [enabled ? "crm.enabledAt" : "crm.disabledAt"]: new Date(),
      },
    },
  );
  revalidatePath(connectionPath(productId, connectionId));
}

/**
 * Which campaign's people the CRM cron looks up. One at a time, so older lists are brought
 * in step by step rather than all at once; new arrivals are looked up regardless.
 */
export async function setCrmBackfillGoal(formData: FormData) {
  const productId = String(formData.get("productId"));
  const connectionId = String(formData.get("connectionId"));
  const goal = String(formData.get("goal") ?? "").trim();
  const { db, connection } = await ownedConnection(connectionId);
  await db
    .collection(C.connections)
    .updateOne({ _id: connection._id }, goal ? { $set: { "crm.sync.backfillGoal": goal } } : { $unset: { "crm.sync.backfillGoal": "" } });
  revalidatePath(connectionPath(productId, connectionId));
}

/**
 * Reads one person from the CRM now, rather than waiting for the poll. Every CRM
 * connection switched on for the product is asked.
 */
export async function syncPersonFromCrm(productId: string, personId: string, _formData?: FormData) {
  const { orgId } = await requireSession();
  const db = await getDb();
  const connections = await db
    .collection(C.connections)
    .find({ orgId, productId, "crm.enabled": true })
    .project({ _id: 1 })
    .toArray();
  for (const c of connections) {
    const connectionId = String(c._id);
    if (!(await lockConnection(connectionId, 60_000))) {
      throw new Error("The CRM is being read right now. Try again in a minute.");
    }
    try {
      await syncPerson(await CrmClient.open(connectionId), personId);
    } finally {
      await unlockConnection(connectionId);
    }
  }
  revalidatePath(`/products/${productId}/library/${personId}`);
}
