"use server";

import { ObjectId } from "mongodb";
import { requiredArgs } from "@/mcp/argcheck.js";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { openSecret, sealSecret, type SealedSecret } from "@/crypto/envelope.js";
import { reverifyConnection } from "@/mcp/reverify.js";
import {
  associateWithTenant,
  configurationSetArn,
  createIdentity,
  createTenant,
  deleteIdentity,
  deleteTenant,
  identityArn,
  identityStatus,
  recreateIdentity,
  tenantArnFor,
} from "@/engine/sesIdentity.js";
import { refreshChannelHealth } from "@/engine/channelHealth.js";
import { buildAuthorizeUrl, createPkce, discoverAuthServer, randomState, registerClient } from "@/mcp/oauth.js";
import {
  buildGoogleAuthorizeUrl,
  configuredScopes,
  googleClient,
  revokeGoogleGrant,
  startGoogleFlow,
} from "@/auth/google.js";
import { headers } from "next/headers";
import { productConfig } from "@/schemas/product.js";
import { asset } from "@/schemas/asset.js";
import { notify, refreshDerived } from "@/engine/notify.js";
import { listCalls, type CallRow, type RoutineKey } from "@/engine/runlog.js";
import { previewContent } from "@/engine/preview.js";
import { enqueue, PRIORITY } from "@/engine/queue.js";
import { fromIstInput } from "./ui/time";
import { setRoutineEnabled } from "@/engine/routines.js";
import { requireSession } from "./tenant";

/** Campaign keys are derived from the name, so nobody has to invent an identifier. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

/** Every action resolves the caller's organisation from their session, never a constant. */
const currentOrg = async () => (await requireSession()).orgId;

// ── products ──────────────────────────────────────────────────────────────────

export async function createProduct(formData: FormData) {
  const db = await getDb();
  const name = String(formData.get("name")).trim();
  const slug = String(formData.get("slug") ?? "").trim() || name.toLowerCase().replace(/\s+/g, "-");
  const website = String(formData.get("website") ?? "").trim();

  const productId = new ObjectId();
  await db.collection(C.products).insertOne({
    _id: productId,
    orgId: (await currentOrg()),
    slug,
    name,
    // A minimal starting config, meant to be replaced — by hand on the product page, or
    // by Claude reading the website during onboarding.
    config: {
      website: website || undefined,
      oneLiner: String(formData.get("oneLiner") ?? ""),
      valueProps: [String(formData.get("valueProp") ?? "Get set up in minutes")],
      segments: [],
      activation: { describedAs: String(formData.get("activation") ?? "First meaningful use"), events: [] },
      voice: { tone: "direct, warm, no hype", do: [], dont: [], readingLevel: 8 },
      constraints: { maxTouchesPerWeek: 2, quietHours: [21, 8], forbiddenClaims: [] },
      suggestedChannels: [{ key: "email", why: "Every lead has one.", priority: 1 }],
      trialLinkTemplate: `${website || "https://example.com"}/start?p={{person_id}}`,
    },
    version: 1,
    status: "active",
    createdAt: new Date(),
  });

  redirect(`/products/${String(productId)}`);
}

export async function saveProductConfig(formData: FormData) {
  const db = await getDb();
  const productId = String(formData.get("productId"));
  let raw: unknown;
  try {
    raw = JSON.parse(String(formData.get("config")));
  } catch {
    throw new Error("Config must be valid JSON");
  }
  const config = productConfig.parse(raw);

  await db
    .collection(C.products)
    .updateOne({ _id: new ObjectId(productId), orgId: (await currentOrg()) }, { $set: { config }, $inc: { version: 1 } });
  revalidatePath(`/products/${productId}`);
}

export async function generateTemplates(productId: string) {
  const db = await getDb();
  const product = await db.collection(C.products).findOne({ _id: new ObjectId(productId), orgId: (await currentOrg()) });
  if (!product) throw new Error("product not found");

  const { generateDefaultTemplates } = await import("@/engine/templates.js");
  await generateDefaultTemplates((await currentOrg()), productId, productConfig.parse(product.config));
  revalidatePath(`/products/${productId}`);
  revalidatePath(`/products/${productId}/templates`);
}

// ── connections ───────────────────────────────────────────────────────────────

/**
 * The secret is sealed here, server-side, and never travels back to the browser or into
 * any tool response. The form posts it once; from then on only the engine can resolve it.
 */
export async function createConnection(formData: FormData) {
  const db = await getDb();
  const productId = String(formData.get("productId"));
  const serverUrl = String(formData.get("serverUrl") ?? "").trim();
  const token = String(formData.get("token") ?? "").trim();
  const provider = String(formData.get("provider") ?? "").trim() || "mcp";
  const account = String(formData.get("account") ?? "").trim();
  if (!serverUrl || !token) throw new Error("Server URL and token are both required");

  const connectionId = new ObjectId();
  await db.collection(C.connections).insertOne({
    _id: connectionId,
    orgId: (await currentOrg()),
    productId,
    key: provider,
    provider,
    // Which account this is authorised as, so switching later has a before and an after.
    ...(account ? { account } : {}),
    authType: "mcp_bearer",
    serverUrl,
    scopes: [],
    status: "pending",
    directions: ["in", "out"],
    createdBy: (await currentOrg()),
    createdAt: new Date(),
  });

  await db.collection(C.credentials).insertOne({
    _id: new ObjectId(),
    orgId: (await currentOrg()),
    connectionId: String(connectionId),
    authType: "mcp_bearer",
    ...sealSecret(token),
    status: "verified",
  });

  redirect(`/products/${productId}/connections/${String(connectionId)}`);
}

/**
 * Swaps the account behind an existing connection instead of standing up a second one.
 *
 * Channels, sources and tool bindings all point at the connection id, so re-authorising in
 * place keeps every one of them wired up. Creating a fresh connection for the new account
 * would leave them addressed to the old account's credential — which is precisely the
 * silent breakage this exists to avoid.
 */
export async function reconnectWithToken(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));
  const connectionId = String(formData.get("connectionId"));
  const token = String(formData.get("token") ?? "").trim();
  const account = String(formData.get("account") ?? "").trim();
  if (!token) throw new Error("An access token is required");

  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId), orgId });
  if (!connection) throw new Error("connection not found");
  const previousAccount = connection.account ? String(connection.account) : undefined;

  await db.collection(C.credentials).updateOne(
    { orgId, connectionId },
    {
      $set: {
        orgId,
        connectionId,
        authType: "mcp_bearer",
        ...sealSecret(token),
        status: "verified",
        rotatedAt: new Date(),
      },
      // The old account's refresh token and expiry must not outlive the account itself,
      // or the broker would quietly refresh its way back to the wrong identity.
      $unset: { refreshTokenEnc: "", expiresAt: "", refreshAfter: "", lastUsedAt: "" },
    },
    { upsert: true },
  );

  await db.collection(C.connections).updateOne(
    { _id: new ObjectId(connectionId) },
    {
      $set: {
        authType: "mcp_bearer",
        status: "verifying",
        reconnectedAt: new Date(),
        ...(account ? { account } : {}),
      },
      $unset: { oauth: "", lastError: "" },
    },
  );

  await recordReconnect(productId, connectionId, previousAccount, account || undefined, "token");
  await reverifyConnection(orgId, connectionId);
  revalidatePath(`/products/${productId}/connections`);
  revalidatePath(`/products/${productId}/connections/${connectionId}`);
}

/**
 * The OAuth half of the same swap. The connection document is reused, so the callback —
 * which finds it by state and upserts the credential by connection id — needs no special
 * case for a re-authorisation.
 */
export async function startReauthOAuth(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));
  const connectionId = String(formData.get("connectionId"));
  const account = String(formData.get("account") ?? "").trim();

  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId), orgId });
  if (!connection?.serverUrl) throw new Error("connection not found");
  const serverUrl = String(connection.serverUrl);

  const metadata = await discoverAuthServer(serverUrl);
  if (!metadata?.authorization_endpoint) {
    throw new Error("This server does not publish OAuth metadata. Reconnect it with an access token instead.");
  }

  const redirectUri = `${await appOrigin()}/api/oauth/callback`;
  const existing = connection.oauth as { clientId?: string; clientSecret?: string } | undefined;
  let clientId = String(formData.get("clientId") ?? "").trim() || existing?.clientId || "";
  let clientSecret = String(formData.get("clientSecret") ?? "").trim() || existing?.clientSecret;

  if (!clientId) {
    const registered = await registerClient(metadata, redirectUri, "Conversion Engine");
    if (!registered) {
      throw new Error(
        "This server does not support dynamic client registration. Enter a client ID issued by the provider.",
      );
    }
    clientId = registered.client_id;
    clientSecret = registered.client_secret;
  }

  const { verifier, challenge } = createPkce();
  const state = randomState();

  await db.collection(C.connections).updateOne(
    { _id: new ObjectId(connectionId) },
    {
      $set: {
        authType: "mcp_oauth",
        status: "pending",
        oauth: { metadata, clientId, clientSecret, verifier, state, redirectUri },
        // Applied by the callback only once the exchange succeeds, so a cancelled consent
        // screen leaves the connection describing the account it still holds.
        pendingAccount: account || undefined,
        reauth: true,
      },
      $unset: { lastError: "" },
    },
  );

  redirect(
    // "login" forces the provider to ask who is signing in. Without it the consent screen
    // reuses the session already open and hands back the same account's token, so the
    // switch looks like it worked and changes nothing.
    buildAuthorizeUrl({ metadata, clientId, redirectUri, challenge, state, resource: serverUrl, prompt: "login" }),
  );
}

/** Reconnects are the kind of change someone asks about weeks later; leave a row saying so. */
async function recordReconnect(
  productId: string,
  connectionId: string,
  fromAccount: string | undefined,
  toAccount: string | undefined,
  via: "token" | "oauth",
) {
  const db = await getDb();
  await db.collection(C.audit).insertOne({
    _id: new ObjectId(),
    orgId: await currentOrg(),
    productId,
    actorType: "user",
    action: "connection.reconnect",
    target: connectionId,
    detail: { via, fromAccount, toAccount },
    at: new Date(),
  });
}

/** Lists the server's tools and records what can be inferred. Never binds automatically. */
export async function discoverTools(productId: string, connectionId: string) {
  await reverifyConnection(await currentOrg(), connectionId);
  revalidatePath(`/products/${productId}/connections/${connectionId}`);
}

/**
 * A binding that omits an argument the tool insists on produces a channel or source that
 * fails on every call, and the failure surfaces per message, hours later, in whatever
 * words the provider chose. The schema is already in hand, so refuse the save instead.
 */
async function assertRequiredArgsMapped(
  orgId: string,
  connectionId: string,
  tool: string,
  args: Record<string, string>,
) {
  const db = await getDb();
  const binding = await db.collection(C.mcpBindings).findOne({ orgId, connectionId });
  const discovered = (binding?.discoveredTools ?? []) as Array<{ name?: string; inputSchema?: unknown }>;
  const schema = discovered.find((t) => t.name === tool)?.inputSchema;
  const missing = requiredArgs(schema).filter((name) => !args[name]);
  if (missing.length > 0) {
    throw new Error(
      `${tool} requires ${missing.join(", ")}. Map ${missing.length === 1 ? "it" : "them"} before saving.`,
    );
  }
}

/** Saves which tool serves a verb, with its argument mapping. */
export async function saveBinding(formData: FormData) {
  const db = await getDb();
  const productId = String(formData.get("productId"));
  const connectionId = String(formData.get("connectionId"));
  const verb = String(formData.get("verb"));
  const tool = String(formData.get("tool"));

  const args: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("arg:") && String(value).trim()) args[key.slice(4)] = String(value).trim();
  }

  await assertRequiredArgsMapped(await currentOrg(), connectionId, tool, args);

  const returnPath = String(formData.get("returnMessageId") ?? "").trim();
  const spec: Record<string, unknown> = { tool, args };
  if (returnPath) spec.returns = { message_id: returnPath };

  await db
    .collection(C.mcpBindings)
    .updateOne({ orgId: (await currentOrg()), connectionId }, { $set: { [`bind.${verb}`]: spec } });
  await db
    .collection(C.connections)
    .updateOne({ _id: new ObjectId(connectionId) }, { $set: { status: "healthy" } });

  revalidatePath(`/products/${productId}/connections/${connectionId}`);
}

// ── channels ──────────────────────────────────────────────────────────────────

/**
 * Blank means "no limit", which is not the same number as zero — and zero on a daily cap
 * means nothing may ever send. Read them apart rather than letting `Number("")` decide.
 */
function optionalNumber(formData: FormData, name: string): number | undefined {
  const raw = String(formData.get(name) ?? "").trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** The provider's limits, read the same way whichever kind of channel is being created. */
function governorFrom(formData: FormData) {
  return {
    dailyCap: Math.max(0, Math.floor(Number(formData.get("dailyCap") ?? 50))),
    perMinute: optionalNumber(formData, "perMinute"),
    perHour: optionalNumber(formData, "perHour"),
    warmupDay: 1,
    sentToday: 0,
    windowStartedAt: new Date(),
  };
}

/**
 * Designed email or plain text, recorded as a human decision.
 *
 * `htmlSource: "human"` is what stops capability rediscovery from quietly overwriting it
 * the next time the connection's tools are listed.
 */
function formatCapsFrom(formData: FormData) {
  return { html: String(formData.get("format") ?? "html") !== "text", htmlSource: "human" };
}


/**
 * Creates an MCP channel and binds its send tool in the same step.
 *
 * Previously these were two screens: bind the tool on Connections, then come here. Since
 * the only reason to bind Send is to have a channel, asking for both at once removes a
 * step people were reliably getting stuck on.
 */
export async function createChannel(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));

  const [connectionId, tool] = String(formData.get("sendTool") ?? "").split("::");
  if (!connectionId || !tool) throw new Error("Pick which tool sends the message.");

  const args: Record<string, string> = {};
  for (const [field, value] of formData.entries()) {
    if (field.startsWith("arg:") && String(value).trim()) args[field.slice(4)] = String(value).trim();
  }

  await assertRequiredArgsMapped(orgId, connectionId, tool, args);

  const returnPath = String(formData.get("returnMessageId") ?? "").trim();
  const spec: Record<string, unknown> = { tool, args };
  if (returnPath) spec.returns = { message_id: returnPath };

  await db
    .collection(C.mcpBindings)
    .updateOne({ orgId, connectionId }, { $set: { "bind.send": spec } }, { upsert: true });
  await db
    .collection(C.connections)
    .updateOne({ _id: new ObjectId(connectionId), orgId }, { $set: { status: "healthy" } });

  await db.collection(C.channels).insertOne({
    _id: new ObjectId(),
    orgId,
    productId,
    connectionId,
    key: String(formData.get("key") ?? "email"),
    kind: "mcp",
    from: String(formData.get("from") ?? "") || undefined,
    replyTo: String(formData.get("replyTo") ?? "") || undefined,
    capabilities: {
      ...(await capabilitiesFor(connectionId)),
      ...formatCapsFrom(formData),
      maxSubjectLength: optionalNumber(formData, "maxSubjectLength"),
      maxBodyLength: optionalNumber(formData, "maxBodyLength"),
    },
    governor: governorFrom(formData),
    policy: { audience: ["cold", "warm_lead", "existing_user"] },
    status: "healthy",
    enabled: true,
  });

  revalidatePath(`/products/${productId}/channels`);
}

async function capabilitiesFor(connectionId: string) {
  const db = await getDb();
  const binding = await db.collection(C.mcpBindings).findOne({ orgId: (await currentOrg()), connectionId });
  const caps = (binding?.capabilities ?? {}) as Record<string, { value: unknown }>;
  const flat: Record<string, unknown> = {};
  for (const [key, cap] of Object.entries(caps)) flat[key] = cap.value;
  // A bound status verb means the provider queues; the engine must reconcile rather than
  // trust the send call.
  const asyncDelivery = Boolean((binding?.bind as Record<string, unknown> | undefined)?.send_status);
  return { send: true, consentRequired: false, asyncDelivery, ...flat };
}

// ── sources ───────────────────────────────────────────────────────────────────

export async function createSource(formData: FormData) {
  const db = await getDb();
  const productId = String(formData.get("productId"));
  const intervalSec = Number(formData.get("intervalSec") ?? 600);

  let fieldMap: Record<string, string | string[]> = { email: "email", name: "name" };
  const raw = String(formData.get("fieldMap") ?? "").trim();
  if (raw) {
    try {
      fieldMap = JSON.parse(raw) as Record<string, string | string[]>;
    } catch {
      throw new Error('Field map must be valid JSON, for example {"email":"Email"}');
    }
  }

  await db.collection(C.sources).insertOne({
    _id: new ObjectId(),
    orgId: (await currentOrg()),
    productId,
    connectionId: String(formData.get("connectionId")),
    name: String(formData.get("name")),
    kind: String(formData.get("kind")),
    triggerMode: String(formData.get("triggerMode")),
    desiredIntervalSec: intervalSec,
    // A platform floor can raise this; both are stored so the UI shows what will actually
    // happen rather than what was asked for.
    effectiveIntervalSec: Math.max(intervalSec, 60),
    fieldMap,
    dedupeKey: String(formData.get("dedupeKey") ?? "email"),
    defaultGoalKey: String(formData.get("defaultGoalKey")),
    enabled: true,
    nextFetchAt: new Date(),
  });
  revalidatePath(`/products/${productId}/sources`);
}

export async function runSourceNow(productId: string, sourceId: string) {
  const { runSource } = await import("@/engine/runSource.js");
  await runSource(sourceId);
  revalidatePath(`/products/${productId}/sources`);
  revalidatePath(`/products/${productId}/leads`);
}

// ── goals ─────────────────────────────────────────────────────────────────────

export async function createGoal(formData: FormData) {
  const db = await getDb();
  const productId = String(formData.get("productId"));
  const name = String(formData.get("name") ?? "").trim();
  const key = slugify(name);
  if (!key) throw new Error("Give the campaign a name.");

  // An input is genuinely required: without one the campaign never starts at all.
  if (String(formData.get("inputType") ?? "none") === "none") {
    throw new Error("This campaign needs an input — a spreadsheet, an audience, an MCP tool or an API.");
  }

  // The verification plan is not, because nobody can write one from a browser. The UI
  // cannot call Claude; it marks the work and a routine picks it up, exactly as it does
  // for classifying a new person. Blocking creation on it would block the user on
  // something only Claude can do.
  const existing = await db.collection(C.goals).findOne({ orgId: await currentOrg(), productId, key });
  const alreadyHasChecks = ((existing?.checks ?? []) as unknown[]).length > 0;
  // Two different questions, deliberately kept apart. Which channels this campaign may
  // ever use is a multiple choice; which one carries the first message is a single one
  // with a fallback, because two messages arriving at once reads as spam.
  const allowedChannels = formData.getAll("allowedChannels").map(String).filter(Boolean);
  const channels = [String(formData.get("primaryChannel") ?? "email"), String(formData.get("fallbackChannel") ?? "")]
    .map((c) => c.trim())
    .filter(Boolean);
  // The first-touch channel is implicitly allowed — picking it is saying so.
  const allowed = allowedChannels.length > 0 ? [...new Set([...allowedChannels, ...channels])] : channels;

  await db.collection(C.goals).updateOne(
    { orgId: (await currentOrg()), productId, key },
    {
      $set: {
        orgId: (await currentOrg()),
        productId,
        key,
        name,
        entry: { expression: "lead_created", minIcpFit: Number(formData.get("minIcpFit") ?? 0) },
        success: {
          expression: String(formData.get("successExpression") ?? "account_created"),
          describedAs: String(formData.get("successDescribed")),
        },
        failure: {
          conditions: ["unsubscribe", "hard_bounce", "explicit_no"],
          silenceDays: Number(formData.get("silenceDays") ?? 30),
        },
        budget: {
          touches: Number(formData.get("touches") ?? 9),
          days: Number(formData.get("days") ?? 30),
          usd: Number(formData.get("usd") ?? 12),
        },
        allowedChannels: allowed,
        verifyConnectionId: String(formData.get("verifyConnectionId") ?? "") || undefined,
        verifyHint: String(formData.get("verifyHint") ?? "").trim() || undefined,
        // Left alone on edit so a plan already written is not wiped by saving the form.
        ...(alreadyHasChecks ? {} : { checks: [] }),
        needsVerificationPlan: !alreadyHasChecks,
        // A priority order, not a broadcast list — exactly one channel carries a touch.
        firstTouch: { templateKey: String(formData.get("firstTouchTemplate")), channels },
        schedule: {
          fetchEverySec: Number(formData.get("fetchEverySec") ?? 600),
          tickEverySec: Number(formData.get("tickEverySec") ?? 600),
          bufferDepth: 3,
          approvalMode: String(formData.get("approvalMode") ?? "gate_on"),
        },
        // Confidence buys patience, not pressure. Someone read as a near-certain fit will
        // convert on a calm sequence; someone read at 5% will not convert on one at all, so
        // they get the tightest gaps and the boldest angles — there is nothing to lose that
        // silence would not lose anyway. "dead" is the exception and stays untouched: a
        // person who has actually said no is a different case from one who has not answered.
        cadenceByTemp: {
          hot: { minGapDays: 2, maxGapDays: 4, maxAssetTier: "C" },
          warm: { minGapDays: 2, maxGapDays: 3, maxAssetTier: "C" },
          cold: { minGapDays: 1, maxGapDays: 2, maxAssetTier: "C" },
          dead: { minGapDays: 999, maxGapDays: 999, maxAssetTier: "A" },
        },
        sourceIds: [],
        enabled: true,
      },
    },
    { upsert: true },
  );

  // The input is part of the goal as far as the user is concerned, so it is created here
  // in the same submit. Underneath it is still a separate source with its own cursor, so
  // two goals reading one endpoint cannot double-process the same person.
  await attachInput(formData, productId, key);

  revalidatePath(`/products/${productId}/goals`);
  revalidatePath(`/products/${productId}/sources`);
}

/**
 * A campaign has one input of each kind, so saving the form again corrects the input it
 * already has rather than stacking a second one beside it. Three saves used to mean three
 * feeds polling the same endpoint, three arrivals per person, and two dead rows that read
 * exactly like the live one.
 *
 * Re-enabling matters as much as the dedupe: deleting a campaign pauses its inputs, and
 * a person re-creating that campaign is asking for it to run again.
 */
async function saveInput(
  productId: string,
  goalKey: string,
  kind: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const db = await getDb();
  const orgId = await currentOrg();

  await db.collection(C.sources).updateOne(
    { orgId, productId, defaultGoalKey: goalKey, kind },
    { $set: { ...fields, kind, enabled: true }, $unset: { health: "", cursor: "" } },
    { upsert: true },
  );
}

/** Creates whichever input the goal form selected, if any. */
async function attachInput(formData: FormData, productId: string, goalKey: string): Promise<void> {
  const db = await getDb();
  const inputType = String(formData.get("inputType") ?? "none");
  if (inputType === "none") return;

  // The goal form names this field "fetchEverySec" and the sources page names it
  // "intervalSec". Reading only one of them left every input created from the goal form
  // polling every ten minutes whatever the user picked.
  const intervalSec =
    Number(formData.get("fetchEverySec") ?? formData.get("intervalSec") ?? 600) || 600;
  const triggerMode = String(formData.get("triggerMode") ?? "batch");
  const dedupeKey = String(formData.get("dedupeKey") ?? "email");

  // Values may be a name, a dotted path, or a list of either tried in order.
  let fieldMap: Record<string, string | string[]> = { email: "email", name: "name" };
  const rawMap = String(formData.get("fieldMap") ?? "").trim();
  if (rawMap) {
    try {
      fieldMap = JSON.parse(rawMap) as Record<string, string | string[]>;
    } catch {
      throw new Error('Field map must be valid JSON, for example {"email":"Email"}');
    }
  }

  const base = {
    orgId: (await currentOrg()),
    productId,
    // An empty field is still a value, so ?? would leave the input unnamed.
    name: String(formData.get("inputName") || goalKey),
    defaultGoalKey: goalKey,
    triggerMode,
    dedupeKey,
    fieldMap,
    enabled: true,
    nextFetchAt: new Date(),
    desiredIntervalSec: intervalSec,
    effectiveIntervalSec: Math.max(intervalSec, 60),
  };

  if (inputType === "audience") {
    const audienceId = String(formData.get("audienceId") ?? "");
    if (!audienceId) throw new Error("Pick which audience this campaign draws from");

    await saveInput(productId, goalKey, "audience", {
      ...base,
      connectionId: "",
      audienceId,
      // The library already holds our own field names, so no mapping is needed.
      fieldMap: { email: "email", name: "name", role: "role", company_domain: "company_domain", timezone: "timezone" },
    });
    return;
  }

  if (inputType === "mcp") {
    // One dropdown carries both halves so the tool can never be paired with the wrong
    // connection: "connectionId::toolName".
    const [connectionId, tool] = String(formData.get("mcpTool") ?? "").split("::");
    if (!connectionId || !tool) throw new Error("Pick which MCP tool returns the leads");

    // Anything not starting with "$" is passed to the tool as a literal, so a fixed
    // argument needs no special handling beyond somewhere to type it.
    let fixed: Record<string, string> = {};
    const rawArgs = String(formData.get("mcpArgs") ?? "").trim();
    if (rawArgs) {
      try {
        fixed = JSON.parse(rawArgs) as Record<string, string>;
      } catch {
        throw new Error('Fixed arguments must be valid JSON, for example {"brandId":"..."}');
      }
    }

    await db
      .collection(C.mcpBindings)
      .updateOne(
        { orgId: (await currentOrg()), connectionId },
        { $set: { "bind.fetch_leads": { tool, args: { ...fixed, cursor: "$cursor" } } } },
        { upsert: true },
      );

    await saveInput(productId, goalKey, "mcp_source", { ...base, connectionId });
    return;
  }

  if (inputType === "api") {
    const endpointUrl = String(formData.get("apiUrl") ?? "").trim();
    const token = String(formData.get("apiToken") ?? "").trim();
    if (!endpointUrl || !token) throw new Error("API input needs a URL and a token");

    const connectionId = new ObjectId();
    await db.collection(C.connections).insertOne({
      _id: connectionId,
      orgId: (await currentOrg()),
      productId,
      key: "api",
      provider: String(formData.get("inputName") ?? "api"),
      authType: "bearer",
      endpointUrl,
      scopes: [],
      status: "healthy",
      directions: ["in"],
      createdBy: (await currentOrg()),
      createdAt: new Date(),
    });
    await db.collection(C.credentials).insertOne({
      _id: new ObjectId(),
      orgId: (await currentOrg()),
      connectionId: String(connectionId),
      authType: "bearer",
      ...sealSecret(token),
      status: "verified",
    });
    await saveInput(productId, goalKey, "api_pull", {
      ...base,
      connectionId: String(connectionId),
      cursorParam: String(formData.get("cursorParam") ?? "") || undefined,
    });
    return;
  }

  if (inputType === "file") {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a spreadsheet to upload");

    // Saving the same form twice should not leave two identical inputs behind. The people
    // dedupe on their own, but the inputs would otherwise accumulate silently.
    const duplicate = await db.collection(C.sources).findOne({
      orgId: (await currentOrg()),
      productId,
      defaultGoalKey: goalKey,
      kind: "excel_upload",
      uploadedFile: file.name,
    });
    if (duplicate) return;

    const { parseSpreadsheet, guessFieldMap } = await import("@/engine/spreadsheet.js");
    const { rows, columns } = parseSpreadsheet(await file.arrayBuffer());
    if (rows.length === 0) throw new Error("That file has no rows");

    // Header names are read from the file itself, so a straightforward export needs no
    // manual mapping at all.
    const guessed = guessFieldMap(columns);
    const sourceId = new ObjectId();
    await db.collection(C.sources).insertOne({
      _id: sourceId,
      ...base,
      connectionId: "",
      kind: "excel_upload",
      triggerMode: "batch",
      // Guesses read from the file's own headers win over the generic defaults. Spreading
      // the defaults last would overwrite a correct "Email" with a literal "email".
      fieldMap: rawMap ? fieldMap : { ...fieldMap, ...guessed },
      uploadedRows: rows.length,
      uploadedFile: file.name,
      // Read by the goals list while the import is still running, so an upload that takes
      // two ticks to finish looks like progress rather than like nothing having happened.
      progress: { done: 0, total: rows.length },
    });

    // The rows are handed to the background queue rather than ingested here. Ingesting a
    // hundred of them inline held this submit for three minutes, and the platform kills a
    // request at sixty seconds, so a larger file did not merely feel slow — it failed
    // half-imported.
    //
    // The chunk is sized so one of them finishes well inside a single tick. Ingest issues
    // a fixed handful of queries per chunk rather than per row, so this is bounded by the
    // document size a chunk carries, not by the time it takes.
    const { enqueue } = await import("@/engine/queue.js");
    const CHUNK = 500;
    const chunks = Math.ceil(rows.length / CHUNK);
    for (let i = 0; i < chunks; i++) {
      await enqueue(await currentOrg(), "ingest_rows", {
        sourceId: String(sourceId),
        rows: rows.slice(i * CHUNK, (i + 1) * CHUNK),
        chunk: i + 1,
        ofChunks: chunks,
      });
    }
  }
}

// ── OAuth connect ─────────────────────────────────────────────────────────────

async function appOrigin(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Starts the OAuth flow. Discovery decides whether this is even possible: a server that
 * publishes no authorization metadata does not speak OAuth, and the caller is told to use
 * a token instead rather than being sent to a broken consent screen.
 */
export async function startOAuth(formData: FormData) {
  const db = await getDb();
  const productId = String(formData.get("productId"));
  const serverUrl = String(formData.get("serverUrl") ?? "").trim();
  const provider = String(formData.get("provider") ?? "").trim() || "mcp";
  const account = String(formData.get("account") ?? "").trim();
  if (!serverUrl) throw new Error("Server URL is required");

  const metadata = await discoverAuthServer(serverUrl);
  if (!metadata?.authorization_endpoint) {
    throw new Error(
      "This server does not publish OAuth metadata. Connect it with an access token instead.",
    );
  }

  const redirectUri = `${await appOrigin()}/api/oauth/callback`;
  let clientId = String(formData.get("clientId") ?? "").trim();
  let clientSecret = String(formData.get("clientSecret") ?? "").trim() || undefined;

  if (!clientId) {
    const registered = await registerClient(metadata, redirectUri, "Conversion Engine");
    if (!registered) {
      throw new Error(
        "This server does not support dynamic client registration. Enter a client ID issued by the provider.",
      );
    }
    clientId = registered.client_id;
    clientSecret = registered.client_secret;
  }

  const { verifier, challenge } = createPkce();
  const state = randomState();

  const connectionId = new ObjectId();
  await db.collection(C.connections).insertOne({
    _id: connectionId,
    orgId: (await currentOrg()),
    productId,
    key: provider,
    provider,
    authType: "mcp_oauth",
    serverUrl,
    scopes: [],
    status: "pending",
    directions: ["in", "out"],
    // Held only until the callback consumes them.
    oauth: { metadata, clientId, clientSecret, verifier, state, redirectUri },
    // Applied by the callback, so an abandoned consent screen leaves no claim about
    // which account this is.
    pendingAccount: account || undefined,
    createdBy: (await currentOrg()),
    createdAt: new Date(),
  });

  redirect(
    buildAuthorizeUrl({ metadata, clientId, redirectUri, challenge, state, resource: serverUrl }),
  );
}

/**
 * Starts a Gmail connect.
 *
 * Nothing is probed first the way the MCP flow probes for metadata: Google's endpoints are
 * fixed, and the only thing that can be misconfigured is our own client, which fails here
 * with a readable message rather than on a consent screen the customer is already looking
 * at.
 */
export async function startGoogleOAuth(formData: FormData) {
  const db = await getDb();
  const productId = String(formData.get("productId"));
  const orgId = await currentOrg();
  const client = googleClient();
  const scopes = configuredScopes();
  const { verifier, challenge, state } = startGoogleFlow();
  const redirectUri = `${await appOrigin()}/api/oauth/google/callback`;

  await db.collection(C.connections).insertOne({
    _id: new ObjectId(),
    orgId,
    productId,
    key: "email",
    provider: "google",
    authType: "oauth2",
    scopes: [],
    status: "pending",
    directions: ["out", "in"],
    // Held only until the callback consumes them. The scopes asked for are kept too, so a
    // customer who unticks one on the consent screen can be told what they actually gave.
    oauth: { verifier, state, redirectUri, scopes },
    createdBy: orgId,
    createdAt: new Date(),
  });

  redirect(
    buildGoogleAuthorizeUrl({
      clientId: client.clientId,
      redirectUri,
      scopes,
      state,
      challenge,
      loginHint: String(formData.get("loginHint") ?? "").trim() || undefined,
    }),
  );
}

/**
 * Reports whether a server can be connected by OAuth, before anyone commits to a path.
 *
 * Returns the answer rather than redirecting with it: the question is asked from inside the
 * connection drawer, and a redirect would close the drawer to say one line.
 */
export async function probeServer(serverUrl: string): Promise<{ oauth: boolean; dcr: boolean; error?: string }> {
  await requireSession();
  const url = serverUrl.trim();
  if (!url) return { oauth: false, dcr: false, error: "Enter a server URL first." };
  try {
    const metadata = await discoverAuthServer(url);
    return {
      oauth: Boolean(metadata?.authorization_endpoint),
      dcr: Boolean(metadata?.registration_endpoint),
    };
  } catch (err) {
    return { oauth: false, dcr: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Whether Google's grant for this mailbox can be handed back without collateral damage.
 *
 * Google revokes per (client, user), not per connection row: the same address connected
 * twice shares one grant, so revoking the copy being deleted would silently kill the copy
 * being kept. When a sibling survives, the local rows still go — the abandoned token simply
 * dies with the sibling's own revoke, or with the grant, rather than taking a working
 * channel down now.
 */
async function revokeIsSafe(orgId: string, connection: Record<string, unknown>): Promise<boolean> {
  if (connection.authType !== "oauth2" || connection.provider !== "google") return false;
  const db = await getDb();
  const siblings = await db.collection(C.connections).countDocuments({
    orgId,
    provider: "google",
    accountEmail: connection.accountEmail,
    _id: { $ne: connection._id as ObjectId },
  });
  return siblings === 0;
}

/**
 * Removes a connection and everything that only existed to serve it: its credential and
 * its tool binding.
 *
 * Refuses while a channel or source still points at it — deleting underneath them would
 * leave goals with a first touch that silently never sends.
 */
export async function deleteConnection(productId: string, connectionId: string, _formData?: FormData) {
  const db = await getDb();

  const orgId = await currentOrg();
  // Everything that addresses a connection by id, not only the two most obvious. A brand
  // source or a goal check left pointing at a deleted connection fails at fetch time, in
  // the provider's own words, long after anyone connects the two events.
  const [channels, sources, brandSources, goals] = await Promise.all([
    db.collection(C.channels).countDocuments({ orgId, connectionId }),
    db.collection(C.sources).countDocuments({ orgId, connectionId }),
    db.collection(C.brandSources).countDocuments({ orgId, connectionId }),
    db.collection(C.goals).countDocuments({
      orgId,
      $or: [{ verifyConnectionId: connectionId }, { "checks.connectionId": connectionId }],
    }),
  ]);
  const inUse = [
    channels && `${channels} channel(s)`,
    sources && `${sources} source(s)`,
    brandSources && `${brandSources} brand source(s)`,
    goals && `${goals} campaign(s) verifying against it`,
  ].filter(Boolean);
  if (inUse.length > 0) {
    throw new Error(
      `In use by ${inUse.join(", ")}. Remove those first — or, to hand this connection to a different account, ` +
        `use Switch account, which keeps every one of them pointed here.`,
    );
  }

  // Tell Google the grant is over before the only copy of the refresh token is destroyed.
  // Dropping the row without revoking leaves the customer's account listing an access this
  // deployment can no longer withdraw.
  const cred = await db.collection(C.credentials).findOne({ orgId, connectionId });
  const sealedRefresh = cred?.refreshTokenEnc as SealedSecret | undefined;
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId), orgId });
  if (connection && sealedRefresh && (await revokeIsSafe(orgId, connection))) {
    await revokeGoogleGrant(openSecret(sealedRefresh));
  }

  await Promise.all([
    db.collection(C.credentials).deleteMany({ orgId: (await currentOrg()), connectionId }),
    db.collection(C.mcpBindings).deleteMany({ orgId: (await currentOrg()), connectionId }),
    db.collection(C.connections).deleteOne({ _id: new ObjectId(connectionId), orgId: (await currentOrg()) }),
  ]);

  await db.collection(C.audit).insertOne({
    _id: new ObjectId(),
    orgId: (await currentOrg()),
    productId,
    actorType: "user",
    action: "connection.delete",
    target: connectionId,
    at: new Date(),
  });

  revalidatePath(`/products/${productId}/connections`);
}

/**
 * Creates a native SMTP channel. Used where a product's own MCP has no send tool — which
 * is the common case, since most product MCPs are read surfaces.
 */
export async function createSmtpChannel(formData: FormData) {
  const db = await getDb();
  const productId = String(formData.get("productId"));
  const host = String(formData.get("host")).trim();
  const port = Number(formData.get("port") ?? 587);
  const user = String(formData.get("user")).trim();
  const pass = String(formData.get("pass"));
  const from = String(formData.get("from")).trim();
  if (!host || !user || !pass || !from) throw new Error("Host, username, password and From are all required");

  const connectionId = new ObjectId();
  await db.collection(C.connections).insertOne({
    _id: connectionId,
    orgId: (await currentOrg()),
    productId,
    key: "smtp",
    provider: String(formData.get("provider") ?? "smtp"),
    authType: "smtp",
    smtp: { host, port, user },
    scopes: [],
    status: "healthy",
    directions: ["out"],
    createdBy: (await currentOrg()),
    createdAt: new Date(),
  });

  await db.collection(C.credentials).insertOne({
    _id: new ObjectId(),
    orgId: (await currentOrg()),
    connectionId: String(connectionId),
    authType: "smtp",
    ...sealSecret(pass),
    status: "verified",
  });

  await db.collection(C.channels).insertOne({
    _id: new ObjectId(),
    orgId: (await currentOrg()),
    productId,
    connectionId: String(connectionId),
    key: "email",
    kind: "native",
    from,
    replyTo: String(formData.get("replyTo") ?? "").trim() || undefined,
    // SMTP delivers but reports nothing back. Declaring that honestly makes the planner
    // drop open-rate-dependent angles instead of scoring every lead as never-opened.
    capabilities: {
      send: true,
      ...formatCapsFrom(formData),
      trackingOpens: false,
      trackingClicks: false,
      bounceWebhook: false,
      inboundReplies: false,
      consentRequired: false,
      fromDomain: "caller_controlled",
      maxSubjectLength: optionalNumber(formData, "maxSubjectLength"),
      maxBodyLength: optionalNumber(formData, "maxBodyLength"),
    },
    governor: governorFrom(formData),
    policy: { audience: ["cold", "warm_lead", "existing_user"] },
    status: "healthy",
    enabled: true,
  });

  revalidatePath(`/products/${productId}/channels`);
}

/**
 * Starts a domain off towards sending: registers it with SES and creates the channel that
 * will use it, degraded, with the DNS the customer still has to publish.
 *
 * The channel is created now rather than when the domain verifies, because a setup with
 * nothing to look at is a setup people abandon. It sends nothing while it is degraded —
 * that is what degraded means to the engine — so an unfinished one is visible and harmless.
 *
 * The Gmail connection is required, not encouraged. SES sends and never receives, so a
 * channel without a mailbox behind it would mail people whose answers vanish, and the
 * campaign would keep chasing someone who already replied. Asked for here as an argument
 * rather than checked later, so there is no order of operations in which it is skipped.
 */
export async function connectSesDomain(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));
  const inboxConnectionId = String(formData.get("inboxConnectionId") ?? "").trim();
  const domain = String(formData.get("domain") ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    // Somebody will paste an address rather than a domain, and the two are one keystroke
    // apart in a field labelled "your domain".
    .replace(/^.*@/, "");

  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw new Error("That does not look like a domain. Enter something like yourcompany.com");
  }

  if (!inboxConnectionId) {
    throw new Error("Connect the Gmail account replies should arrive in first — SES can send but never receive.");
  }
  const inbox = await db
    .collection(C.connections)
    .findOne({ _id: new ObjectId(inboxConnectionId), orgId, authType: "oauth2", provider: "google" });
  if (!inbox) throw new Error("That mailbox connection no longer exists — connect Gmail again.");

  // One domain, one org. SES would happily let a second tenant create an identity for a
  // domain already verified in this account and start sending as it: AWS is checking that
  // somebody proved control, not that this customer did.
  const claimed = await db
    .collection(C.connections)
    .findOne({ authType: "ses", "ses.domain": domain, orgId: { $ne: orgId } });
  if (claimed) {
    throw new Error(`${domain} is already connected by another account. Contact support if that is wrong.`);
  }

  const identity = await createIdentity(domain, productId);

  // The tenant this product sends as, and the two associations that make it usable. Every
  // step is optional in the sense that a failure degrades rather than blocks: without a
  // tenant the domain still sends, on the account's shared reputation, which is exactly
  // where this design was before tenants existed.
  const tenant = await createTenant(productId);
  const domainArn = identityArn(domain);
  const configArn = configurationSetArn(identity.configurationSetName);
  let tenantReady = false;
  let tenantReason: string | undefined;
  if (tenant && domainArn && configArn) {
    // Both, or neither. SendEmail with a TenantName is refused unless every resource it
    // references belongs to that tenant, so associating only the identity would produce a
    // channel that cannot send at all — strictly worse than no tenant.
    const identityBound = await associateWithTenant(tenant.tenantName, domainArn);
    const configBound = identityBound.ok
      ? await associateWithTenant(tenant.tenantName, configArn)
      : { ok: false, reason: identityBound.reason };
    tenantReady = configBound.ok;
    tenantReason = configBound.reason;
  }
  const from = String(formData.get("from") ?? "").trim() || `hello@${domain}`;
  if (!from.endsWith(`@${domain}`)) {
    throw new Error(`The From address has to be on ${domain} — that is the domain being verified.`);
  }

  const connectionId = new ObjectId();
  await db.collection(C.connections).insertOne({
    _id: connectionId,
    orgId,
    productId,
    key: "ses",
    provider: "amazonses",
    authType: "ses",
    ses: {
      domain: identity.domain,
      status: identity.status,
      dkimTokens: identity.dkimTokens,
      records: identity.records,
      configurationSetName: identity.configurationSetName,
      mailFromDomain: identity.mailFromDomain,
      checksUntil: identity.checksUntil,
      // Only set when the tenant exists AND both resources are associated. Sending reads
      // this field, so a half-built tenant must not be recorded as one.
      ...(tenantReady && tenant
        ? { tenantName: tenant.tenantName, tenantArn: tenant.tenantArn ?? tenantArnFor(tenant.tenantName) }
        : {}),
      // Why this product has no tenant, when it has none. An isolation gap that is
      // invisible is one nobody fixes.
      ...(tenantReady
        ? {}
        : {
            tenantSkipped: !tenant
              ? "Amazon refused to create a tenant — this domain sends on the account's shared reputation."
              : `Tenant created but its resources could not be associated, so sending stays account-level.${
                  tenantReason ? ` ${tenantReason}` : ""
                }`,
          }),
    },
    accountEmail: from,
    scopes: [],
    status: "degraded",
    directions: ["out"],
    createdBy: orgId,
    createdAt: new Date(),
  });

  const channelId = new ObjectId();
  await db.collection(C.channels).insertOne({
    _id: channelId,
    orgId,
    productId,
    connectionId: String(connectionId),
    // The other half of the pair, and the reason this channel can hold a conversation.
    inboxConnectionId,
    key: "email",
    kind: "native",
    from,
    replyTo: String(formData.get("replyTo") ?? "").trim() || undefined,
    capabilities: {
      send: true,
      html: true,
      designedHtml: true,
      trackingOpens: true,
      trackingClicks: true,
      // The thing Gmail could not do. Declared true so the planner stops treating a silent
      // send as evidence of anything.
      bounceWebhook: true,
      // Replies arrive in the paired mailbox, not here, but from the campaign's point of
      // view this channel can be replied to — which is what this flag decides.
      inboundReplies: true,
      consentRequired: false,
      fromDomain: "caller_controlled",
    },
    // A new domain has no reputation at all. Starting at volume is how it acquires a bad
    // one, so the ramp is the default rather than something to remember to turn on.
    governor: { perMinute: 10, perHour: 200, dailyCap: 50, warmupDay: 1 },
    policy: { audience: ["cold", "warm_lead", "existing_user"] },
    status: "degraded",
    enabled: true,
  });

  await refreshChannelHealth(orgId, String(channelId));
  revalidatePath(`/products/${productId}/channels`);
}

/**
 * Asks AWS again, now, for somebody watching the page rather than waiting for the tick.
 *
 * The tick is what actually brings a channel up; this exists because a person who has just
 * pasted three records wants to know within seconds whether they got them right, and
 * telling them to wait a minute for a cron is a worse answer than one API call.
 */
export async function recheckSesDomain(productId: string, connectionId: string, _formData?: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const connection = await db
    .collection(C.connections)
    .findOne({ _id: new ObjectId(connectionId), orgId, authType: "ses" });
  if (!connection) throw new Error("that domain is no longer connected");

  const identity = connection.ses as { domain?: string };
  const status = await identityStatus(String(identity.domain));

  await db.collection(C.connections).updateOne(
    { _id: connection._id },
    {
      $set: {
        "ses.status": status.status,
        "ses.mailFromReady": status.mailFromReady,
        "ses.checkedAt": new Date(),
        status: status.status === "verified" ? "healthy" : "degraded",
      },
    },
  );

  const channel = await db.collection(C.channels).findOne({ orgId, connectionId });
  if (channel) await refreshChannelHealth(orgId, String(channel._id));

  revalidatePath(`/products/${productId}/channels`);
}

/**
 * Throws away a domain AWS stopped checking and starts it again with fresh tokens.
 *
 * New tokens mean new DNS, so this is destructive to whatever the customer already
 * published — which is why it is a button they press rather than something the tick does on
 * their behalf when the deadline passes.
 */
export async function restartSesDomain(productId: string, connectionId: string, _formData?: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const connection = await db
    .collection(C.connections)
    .findOne({ _id: new ObjectId(connectionId), orgId, authType: "ses" });
  if (!connection) throw new Error("that domain is no longer connected");

  const domain = String((connection.ses as { domain?: string }).domain);
  const identity = await recreateIdentity(domain, productId);

  await db.collection(C.connections).updateOne(
    { _id: connection._id },
    {
      $set: {
        "ses.status": identity.status,
        "ses.dkimTokens": identity.dkimTokens,
        "ses.records": identity.records,
        "ses.checksUntil": identity.checksUntil,
        status: "degraded",
      },
    },
  );

  const channel = await db.collection(C.channels).findOne({ orgId, connectionId });
  if (channel) await refreshChannelHealth(orgId, String(channel._id));

  revalidatePath(`/products/${productId}/channels`);
}

/**
 * Turns the designed-HTML capability on or off by hand.
 *
 * Discovery reads capabilities off the send tool's arguments, which is a guess — a good
 * one, but a guess a person can be certain about. Marking it by hand records that
 * certainty, and nothing rediscovers over it, because a human reading the provider's docs
 * outranks a regular expression reading its schema.
 */
/**
 * Everything about a live channel that is worth correcting without rebuilding it.
 *
 * These were create-only fields, which meant a daily cap typed once — or left at the form
 * default — could never be changed again except by writing to the database by hand. A cap
 * is the single most consequential number here: campaigns are planned against it, and the
 * messages it stops are approved ones.
 */
export async function updateChannel(productId: string, channelId: string, formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const channel = await db.collection(C.channels).findOne({ _id: new ObjectId(channelId), orgId, productId });
  if (!channel) throw new Error("channel not found");

  const status = String(formData.get("status") ?? "healthy");
  const format = formatCapsFrom(formData);
  const governor = governorFrom(formData);

  const fields: Record<string, unknown> = {
    key: String(formData.get("key") ?? channel.key),
    "governor.dailyCap": governor.dailyCap,
    // The stale counter is zeroed on every save rather than left to drift further.
    // Nothing reads it for a decision any more, but a wrong number on a screen is still
    // a number someone will plan around.
    "governor.sentToday": 0,
    "governor.windowStartedAt": new Date(),
    "capabilities.html": format.html,
    "capabilities.htmlSource": format.htmlSource,
    status,
    // A paused channel must stop being picked for new touches too, not merely refuse at
    // send time — otherwise every campaign keeps planning into a dead end.
    enabled: status === "healthy",
  };
  // The driver is built with ignoreUndefined, so an emptied field has to be unset by name:
  // setting it to undefined would silently leave the old limit in place.
  const cleared: Record<string, ""> = {};
  const put = (path: string, value: number | string | undefined) => {
    if (value === undefined || value === "") cleared[path] = "";
    else fields[path] = value;
  };
  put("governor.perMinute", governor.perMinute);
  put("governor.perHour", governor.perHour);
  put("capabilities.maxSubjectLength", optionalNumber(formData, "maxSubjectLength"));
  put("capabilities.maxBodyLength", optionalNumber(formData, "maxBodyLength"));
  put("from", String(formData.get("from") ?? "").trim());
  put("replyTo", String(formData.get("replyTo") ?? "").trim());

  // Rebinding the send tool. Only MCP channels have one, and the binding lives on the
  // connection rather than the channel — so this is also how a channel is moved to a
  // different server, and why the drawer says which connection it belongs to.
  const sendTool = String(formData.get("sendTool") ?? "").trim();
  if (sendTool) {
    const [connectionId, tool] = sendTool.split("::");
    if (!connectionId || !tool) throw new Error("Pick which tool sends the message.");

    const args: Record<string, string> = {};
    for (const [field, value] of formData.entries()) {
      if (field.startsWith("arg:") && String(value).trim()) args[field.slice(4)] = String(value).trim();
    }
    await assertRequiredArgsMapped(orgId, connectionId, tool, args);

    const returnPath = String(formData.get("returnMessageId") ?? "").trim();
    const spec: Record<string, unknown> = { tool, args };
    if (returnPath) spec.returns = { message_id: returnPath };

    await db
      .collection(C.mcpBindings)
      .updateOne({ orgId, connectionId }, { $set: { "bind.send": spec } }, { upsert: true });
    fields.connectionId = connectionId;
  }

  await db.collection(C.channels).updateOne(
    { _id: new ObjectId(channelId), orgId, productId },
    { $set: fields, ...(Object.keys(cleared).length ? { $unset: cleared } : {}) },
  );

  // Anything this channel's own limits were holding back is released to be re-judged now.
  //
  // A deferred message carries a `dueAt` computed from the limit in force when it was
  // deferred. Raise the cap afterwards and it stays parked at the old refill time — 78
  // free slots and twelve messages waiting until tomorrow morning for a cap that no longer
  // exists. Lowering a limit is handled by the same line: they come due, fireDue re-checks
  // the real limit, and defers them again with an honest date.
  await db.collection(C.actions).updateMany(
    { orgId, productId, channelId, status: "queued", deferReason: { $exists: true } },
    { $set: { dueAt: new Date() }, $unset: { deferReason: "" } },
  );

  revalidatePath(`/products/${productId}/channels`);
  // What a channel can carry decides what every campaign on it composes, so the pages that
  // render a message have to be rebuilt with it.
  revalidatePath(`/products/${productId}/review`, "layout");
}

/**
 * Removes a channel and everything that only existed to serve it.
 *
 * Deleting the channel row alone is not a delete. A mailbox connected through the Gmail
 * flow leaves behind a connection and a stored refresh token, and the broker keeps renewing
 * that token on a schedule — so a customer who disconnects a channel in the UI still has a
 * live grant against their mailbox, and the next connect adds a second healthy connection
 * beside the abandoned one. That is the leak this cascade closes.
 *
 * What is *not* cascaded: an MCP connection. Those are shared — a source, a brand source or
 * a campaign's verifier can be pointed at the same server — so they are left for
 * deleteConnection, which refuses while anything still uses them. Only a provider mailbox
 * (authType oauth2), created by the connect flow purely to back this channel and used by
 * nothing else, is torn down here.
 *
 * Sent actions survive. They are the record of what a real person received, and a deleted
 * channel does not unsend them.
 */
export async function deleteChannel(productId: string, channelId: string, _formData?: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const channel = await db
    .collection(C.channels)
    .findOne({ _id: new ObjectId(channelId), orgId });
  if (!channel) return;

  await db.collection(C.channels).deleteOne({ _id: new ObjectId(channelId), orgId });

  // Queued work naming a channel that no longer exists can never be picked up, and would
  // sit in the review queue forever looking sendable. Sent, failed and skipped actions stay
  // — they are history, and a deleted channel does not change what already happened.
  await db.collection(C.actions).deleteMany({ orgId, channelId, status: "queued" });

  // Both of them. A channel sending through SES names two connections — the domain it sends
  // as, and the mailbox its replies arrive in — and a cascade that only knew about the
  // first left every premium tenant's Google grant alive after they removed the channel,
  // which is the exact leak this cascade was written to close.
  for (const connectionId of [channel.connectionId, channel.inboxConnectionId]
    .filter(Boolean)
    .map(String)) {
    const connection = await db
      .collection(C.connections)
      .findOne({ _id: new ObjectId(connectionId), orgId });
    if (!connection) continue;

    // Only ours to tear down, and only once nothing else points at it.
    const stillUsed =
      (await db.collection(C.channels).countDocuments({
        orgId,
        $or: [{ connectionId }, { inboxConnectionId: connectionId }],
      })) +
      (await db.collection(C.sources).countDocuments({ orgId, connectionId })) +
      (await db.collection(C.brandSources).countDocuments({ orgId, connectionId })) +
      (await db.collection(C.goals).countDocuments({
        orgId,
        $or: [{ verifyConnectionId: connectionId }, { "checks.connectionId": connectionId }],
      }));
    if (stillUsed > 0) continue;

    if (connection.authType === "oauth2") {
      // Revoke before deleting: once the sealed refresh token is gone there is no second
      // chance to tell Google the grant is finished, and it would stay listed in the
      // customer's account with nothing on our side able to withdraw it.
      const cred = await db.collection(C.credentials).findOne({ orgId, connectionId });
      const sealedRefresh = cred?.refreshTokenEnc as SealedSecret | undefined;
      if (sealedRefresh && (await revokeIsSafe(orgId, connection))) {
        await revokeGoogleGrant(openSecret(sealedRefresh));
      }
      await db.collection(C.credentials).deleteMany({ orgId, connectionId });
      await db.collection(C.connections).deleteOne({ _id: new ObjectId(connectionId), orgId });
      continue;
    }

    if (connection.authType === "ses") {
      // The identity goes back to AWS as well. Leaving it costs nothing in money and
      // everything in confusion: the domain stays verified in the account, so the next
      // tenant to claim it is handed a working channel for a domain they may not own.
      const identity = connection.ses as { domain?: string; tenantName?: string } | undefined;
      if (identity?.domain) await deleteIdentity(identity.domain);
      // The tenant goes too. Left behind it would be adopted by the next connect for this
      // product with whatever suppression list the abandoned one had accumulated.
      if (identity?.tenantName) await deleteTenant(identity.tenantName);
      await db.collection(C.connections).deleteOne({ _id: new ObjectId(connectionId), orgId });
    }
  }

  await db.collection(C.audit).insertOne({
    _id: new ObjectId(),
    orgId,
    productId,
    actorType: "user",
    action: "channel.delete",
    target: channelId,
    at: new Date(),
  });

  revalidatePath(`/products/${productId}/channels`);
  revalidatePath(`/products/${productId}/connections`);
  // A campaign composes against what its channel can carry, so the pages that render a
  // message have to be rebuilt without it.
  revalidatePath(`/products/${productId}/review`, "layout");
}

/**
 * Deletes a goal and everything that only existed because of it: its instances, plans and
 * queued actions. Sent history is kept — it is the record of what a real person received.
 */
export async function deleteGoal(productId: string, goalKey: string, _formData?: FormData) {
  const db = await getDb();
  const s = { orgId: (await currentOrg()), productId };

  const instances = await db.collection(C.goalInstances).find({ ...s, goalKey }).project({ _id: 1 }).toArray();
  const ids = instances.map((i) => String(i._id));

  await Promise.all([
    db.collection(C.actions).deleteMany({ ...s, goalInstanceId: { $in: ids }, status: { $ne: "sent" } }),
    db.collection(C.plans).deleteMany({ goalInstanceId: { $in: ids } }),
    db.collection(C.goalInstances).deleteMany({ ...s, goalKey }),
    db.collection(C.goals).deleteOne({ ...s, key: goalKey }),
    db.collection(C.sources).updateMany({ ...s, defaultGoalKey: goalKey }, { $set: { enabled: false } }),
  ]);

  revalidatePath(`/products/${productId}/goals`);
  revalidatePath(`/products/${productId}/sources`);
}

export async function deleteSource(productId: string, sourceId: string, _formData?: FormData) {
  const db = await getDb();
  await db.collection(C.sources).deleteOne({ _id: new ObjectId(sourceId), orgId: (await currentOrg()) });
  revalidatePath(`/products/${productId}/sources`);
}

export async function toggleSource(productId: string, sourceId: string, enabled: boolean) {
  const db = await getDb();
  await db.collection(C.sources).updateOne(
    { _id: new ObjectId(sourceId), orgId: (await currentOrg()) },
    { $set: { enabled, ...(enabled ? { nextFetchAt: new Date() } : {}) } },
  );
  revalidatePath(`/products/${productId}/sources`);
}

/** Releases or rejects messages held for review. */
export async function decide(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));
  const ids = formData.getAll("ids").map((v) => new ObjectId(String(v)));
  const approve = String(formData.get("decision")) === "approve";
  // Where to send the reader back to, so a decision made on the scheduled list does not
  // silently return them to the gate.
  const back = String(formData.get("back") ?? "");
  // The reviewer is looking at the designed mail; sending it as plain text is their call
  // to make here, on the message in front of them, not a template-wide setting.
  const asText = String(formData.get("format") ?? "html") === "text";

  const result = await db.collection(C.actions).updateMany(
    {
      _id: { $in: ids },
      orgId,
      productId,
      // Both states a reviewer can act on: one has reached the gate, the other is dated for
      // later and has not been decided on. Matching only the first meant a reviewer could
      // click Approve on a scheduled message and have nothing happen at all — no change, no
      // error, no explanation. Deciding early on a message you have read is a real decision,
      // and the system should keep it rather than quietly discard it.
      $or: [{ status: "awaiting_approval" }, { status: "queued", reviewedAt: { $exists: false } }],
    },
    // Approving returns it to the queue rather than sending directly, so budgets, caps and
    // suppression are all still checked at the moment it actually goes out. A message dated
    // for next week keeps that date; approving it early only means it will not stop here
    // again on the way out.
    {
      $set: { status: approve ? "queued" : "skipped", reviewedAt: new Date(), format: asText ? "text" : "html" },
      // Dropping the rendered HTML is not enough on its own — the sender rebuilds it from
      // the template when it is missing, so the choice is recorded on the action too.
      ...(approve && asText ? { $unset: { "content.bodyHtml": "" } } : {}),
    },
  );

  revalidatePath(`/products/${productId}/review`, "layout");

  // Says what happened. A bulk decision that changes the page underneath you and reports
  // nothing leaves you counting rows to work out whether it worked — and when this action
  // silently matched none of them, that was the only way to find out at all.
  const params = new URLSearchParams(back);
  params.set(approve ? "approved" : "rejected", String(result.modifiedCount));
  redirect(`/products/${productId}/review?${params.toString()}`);
}

/**
 * Puts messages that never reached anyone back in front of a reviewer.
 *
 * A cap that fills mid-batch used to be the end of those messages: `skipped` is terminal,
 * nothing retries it, and raising the cap afterwards does not bring them back. The same was
 * true of a send the provider refused — an hourly cap on their side left fifty perfectly
 * good messages `failed` with no way out of that screen. They are still approved, composed
 * and frozen, so both kinds come back here rather than making anyone rebuild the campaign.
 *
 * Only messages the machine stopped are eligible. A rejection has no `skipReason`, and
 * resurrecting something a human turned down is not a recovery, it is an override.
 */
export async function returnToReview(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));
  const ids = formData.getAll("ids").map((v) => new ObjectId(String(v)));
  if (ids.length === 0) return;

  const result = await db.collection(C.actions).updateMany(
    {
      _id: { $in: ids },
      orgId,
      productId,
      $or: [{ status: "skipped", skipReason: { $exists: true } }, { status: "failed" }],
    },
    {
      // `reviewedAt` is deliberately kept. The sender reuses stored content for a message
      // that has been reviewed, so what goes out is the text that was approved, not a
      // fresh render of a template that may have changed since.
      $set: { status: "awaiting_approval" },
      // Every one of these describes a moment that has passed — an hour's cap, a provider
      // that was refusing at the time. Leaving them would label a message in the review
      // queue with a block that no longer applies.
      $unset: { skipReason: "", deferReason: "", error: "" },
    },
  );

  revalidatePath(`/products/${productId}/review`, "layout");
  // The dashboard counts these in its "failed to send" alert, so it is stale the moment
  // any of them move.
  revalidatePath(`/products/${productId}`);
}

/**
 * Which states a message may still be changed in.
 *
 * A sent message is a record of what somebody received, and editing it would make the
 * console lie about the thing it exists to answer. Everything before the send is fair game,
 * including a failure — that one is going to be looked at again by definition.
 */
const EDITABLE = ["awaiting_approval", "queued", "failed", "skipped"];

async function editableAction(actionId: string) {
  const db = await getDb();
  const orgId = await currentOrg();
  const action = await db.collection(C.actions).findOne({ _id: new ObjectId(actionId), orgId });
  if (!action) throw new Error("that message no longer exists");
  if (!EDITABLE.includes(String(action.status))) {
    throw new Error(
      `This message is ${String(action.status)} — it has already gone out, so it is a record now rather than a draft.`,
    );
  }
  return { db, orgId, action };
}

/** Every change to a message, recorded with who made it. */
async function recordEdit(productId: string, actionId: string, what: string, detail?: string) {
  const db = await getDb();
  await db.collection(C.audit).insertOne({
    _id: new ObjectId(),
    orgId: await currentOrg(),
    productId,
    actorType: "user",
    action: `message.${what}`,
    target: actionId,
    detail,
    at: new Date(),
  });
}

/**
 * The words, rewritten by the person reviewing them.
 *
 * Saved as `slotText` rather than as the finished body, because the greeting, the button
 * and the opt-out line belong to the template and are added at send. Writing the rendered
 * body back instead would bake one render of the skeleton into the message and duplicate
 * whatever the skeleton adds next time.
 */
export async function editMessage(formData: FormData) {
  const productId = String(formData.get("productId"));
  const actionId = String(formData.get("actionId"));
  const subject = String(formData.get("subject") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!body) throw new Error("A message needs words. Reject it instead if it should not go.");

  const { db, action } = await editableAction(actionId);
  await db.collection(C.actions).updateOne(
    { _id: action._id },
    {
      $set: {
        "content.subject": subject || undefined,
        "content.slotText": body,
        "content.wordCount": body.split(/\s+/).filter(Boolean).length,
        // The rendered halves are dropped so the next render rebuilds them from this text.
        // Leaving them would show the reviewer their own edit and send the old words.
        editedAt: new Date(),
        editedBy: "human",
      },
      $unset: { "content.bodyMd": "", "content.bodyHtml": "", "content.fromBlocks": "" },
    },
  );
  await recordEdit(productId, actionId, "edit", subject || undefined);
  revalidatePath(`/products/${productId}/review`, "layout");
}

/**
 * When it goes out.
 *
 * The engine sends on `dueAt` under every guardrail, so moving the date is the whole of
 * rescheduling — there is no separate schedule to keep in step with it.
 */
export async function rescheduleMessage(formData: FormData) {
  const productId = String(formData.get("productId"));
  const actionId = String(formData.get("actionId"));
  const when = fromIstInput(String(formData.get("dueAt") ?? ""));
  if (!when) throw new Error("That is not a date this can send on.");

  const { db, action } = await editableAction(actionId);
  await db.collection(C.actions).updateOne(
    { _id: action._id },
    // A message that failed or was stopped is put back in the queue by the same move: it
    // has a future date now, and leaving it `failed` would date a message nothing will send.
    { $set: { dueAt: when, ...(String(action.status) === "queued" || String(action.status) === "awaiting_approval" ? {} : { status: "queued" }) }, $unset: { error: "", skipReason: "", deferReason: "" } },
  );
  await recordEdit(productId, actionId, "reschedule", when.toISOString());
  revalidatePath(`/products/${productId}/review`, "layout");
}

/**
 * Ask for it to be written again.
 *
 * Clears the copy and puts the person at the front of the writing queue rather than
 * generating anything here: composing is a routine's job, with the person's history, the
 * claims already made and the campaign's angles in front of it — none of which a button in
 * a drawer has. Urgent, because somebody asking for a rewrite is watching for it.
 */
export async function regenerateMessage(formData: FormData) {
  const productId = String(formData.get("productId"));
  const actionId = String(formData.get("actionId"));
  const instruction = String(formData.get("instruction") ?? "").trim();

  const { db, orgId, action } = await editableAction(actionId);
  await db.collection(C.actions).updateOne(
    { _id: action._id },
    {
      $set: {
        rewriteRequestedAt: new Date(),
        rewriteNote: instruction || undefined,
        // Back to the gate: a rewrite nobody has read is not an approved message.
        status: "awaiting_approval",
      },
      $unset: { "content.slotText": "", "content.bodyMd": "", "content.bodyHtml": "", reviewedAt: "", error: "", skipReason: "" },
    },
  );

  await enqueue(
    orgId,
    "compose",
    {
      actionId,
      personId: String(action.personId),
      goalInstanceId: String(action.goalInstanceId),
      reason: instruction || "a reviewer asked for this message to be written again",
    },
    { subjectId: String(action.personId), productId, priority: PRIORITY.urgent },
  );

  await recordEdit(productId, actionId, "regenerate", instruction || undefined);
  revalidatePath(`/products/${productId}/review`, "layout");
}

/** What a message actually says, fetched only when a reviewer opens it. */
export interface HeldMessage {
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  rationale?: string;
  /** False when the channel cannot carry HTML, so the designed version is not on offer. */
  canHtml: boolean;
  /** The action's own status, so the drawer knows whether a decision is still on offer. */
  status: string;
  /** Why a message that was approved never went out — a cap, a suppression, an error. */
  skipReason?: string;
  sentAt?: string;
  reviewedAt?: string;
  /**
   * True when the body shown was rendered here rather than read off the action, because
   * the message has not been through a render yet. The words are the ones that will go
   * out; the reviewer is told so they know why the body can still change if the template
   * does.
   */
  preview?: boolean;
  /** Why nothing could be shown, when even the render failed. */
  previewError?: string;
  /**
   * The words a reviewer may edit — the slot copy alone, not the rendered message. Editing
   * the rendered body would bake the template's greeting and button into the copy, and the
   * next render would add its own on top.
   */
  editableBody?: string;
  /** When it is set to go, for the reschedule field. */
  dueAt?: string;
  /** Whether the message may still be changed at all. */
  editable: boolean;
  /** Set while a rewrite has been asked for and the writing routine has not run yet. */
  rewriteRequestedAt?: string;
}

/**
 * The body of one message in the review list.
 *
 * The review list is a table now, and a page of 500 rows carrying a rendered email each is
 * megabytes of HTML to show six columns of metadata. The body is read when the drawer
 * opens instead.
 *
 * Any status is readable, not only the ones still waiting: "what exactly did we send that
 * person" is the question asked most often, and it is unanswerable if the record disappears
 * from view the moment it is approved.
 */
export async function heldMessage(actionId: string): Promise<HeldMessage | null> {
  const db = await getDb();
  const orgId = await currentOrg();
  const action = await db.collection(C.actions).findOne({ _id: new ObjectId(actionId), orgId });
  if (!action) return null;

  const content = (action.content ?? {}) as { subject?: string; bodyMd?: string; bodyHtml?: string };
  // Whether the designed version is even an option is the channel's business, not the
  // template's, so the drawer is told rather than left to guess.
  const channel = action.channelId
    ? await db.collection(C.channels).findOne({ _id: new ObjectId(String(action.channelId)) })
    : null;
  const caps = (channel?.capabilities ?? {}) as { html?: boolean };

  // Copy written by a session lives in `slotText` until the sender wraps it in its
  // template, so `bodyMd` is empty for every message composed that way. Reading it alone
  // showed the reviewer a subject over a blank page — nothing to approve on, and no sign
  // anything was missing. Render it the way the sender will instead.
  let rendered: { subject?: string; bodyMd?: string; bodyHtml?: string } | undefined;
  let previewError: string | undefined;
  if (!content.bodyMd) {
    try {
      rendered = await previewContent(orgId, action);
    } catch (err) {
      previewError = err instanceof Error ? err.message : "this message could not be rendered";
    }
  }

  const slot = (action.content as { slotText?: string } | undefined)?.slotText;
  return {
    subject: content.subject ?? rendered?.subject,
    bodyHtml: content.bodyHtml ?? rendered?.bodyHtml,
    bodyText: content.bodyMd || rendered?.bodyMd,
    preview: Boolean(rendered),
    previewError,
    // The slot if there is one; otherwise the rendered body, which is what a reviewer
    // would otherwise have to retype to change one line of a template default.
    editableBody: slot || content.bodyMd || rendered?.bodyMd,
    dueAt: action.dueAt ? new Date(String(action.dueAt)).toISOString() : undefined,
    editable: EDITABLE.includes(String(action.status)),
    rewriteRequestedAt: action.rewriteRequestedAt
      ? new Date(String(action.rewriteRequestedAt)).toISOString()
      : undefined,
    rationale: action.rationale ? String(action.rationale) : undefined,
    canHtml: caps.html !== false,
    status: String(action.status),
    skipReason: action.skipReason ? String(action.skipReason) : action.error ? String(action.error) : undefined,
    sentAt: action.sentAt ? new Date(String(action.sentAt)).toISOString() : undefined,
    reviewedAt: action.reviewedAt ? new Date(String(action.reviewedAt)).toISOString() : undefined,
  };
}

// ── library ───────────────────────────────────────────────────────────────────

/**
 * Adds people to the library with no campaign attached. Without this the library only ever
 * holds people you had already decided to chase, which defeats the point of having one.
 */
export async function importPeople(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));
  const now = new Date();

  let rows: Array<Record<string, unknown>> = [];
  let kind = "manual";

  const file = formData.get("file");
  if (file instanceof File && file.size > 0) {
    const { parseSpreadsheet, guessFieldMap } = await import("@/engine/spreadsheet.js");
    const parsed = parseSpreadsheet(await file.arrayBuffer());
    const map = guessFieldMap(parsed.columns);
    kind = "file_upload";
    rows = parsed.rows.map((r) => ({
      email: map.email ? r[map.email] : undefined,
      name: map.name ? r[map.name] : undefined,
      role: map.role ? r[map.role] : undefined,
      company_domain: map.company_domain ? r[map.company_domain] : undefined,
    }));
  } else {
    // One per line: an address on its own, or "Name <address>".
    const pasted = String(formData.get("pasted") ?? "").trim();
    rows = pasted
      .split(/[\n,;]+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(.*?)\s*<([^>]+)>$/);
        return match ? { name: match[1]?.trim(), email: match[2] } : { email: line };
      });
  }

  let added = 0;
  let merged = 0;
  let skipped = 0;

  for (const row of rows) {
    const email = String(row.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      skipped++;
      continue;
    }

    // Someone who said no is never re-added by an import.
    const blocked = await db.collection(C.suppressions).findOne({ orgId, identityValue: email });
    if (blocked) {
      skipped++;
      continue;
    }

    const existing = await db
      .collection(C.people)
      .findOne({ orgId, productId, "identities.value": email });

    if (existing) {
      await db.collection(C.people).updateOne({ _id: existing._id }, {
        $push: { arrivals: { kind, at: now, detail: "library import" } },
      } as never);
      merged++;
      continue;
    }

    await db.collection(C.people).insertOne({
      _id: new ObjectId(),
      orgId,
      productId,
      identities: [{ kind: "email", value: email, verified: false }],
      primaryEmail: email,
      name: row.name ? String(row.name) : undefined,
      role: row.role ? String(row.role) : undefined,
      companyDomain: row.company_domain ? String(row.company_domain) : email.split("@")[1],
      timezone: "UTC",
      language: "en",
      stage: "lead",
      consent: { state: "legitimate_interest", capturedAt: now, evidence: `library:${kind}` },
      arrivals: [{ kind, at: now, detail: "library import" }],
      lifecycle: "new",
      attempts: 0,
      objections: [],
      investment: { messages: 0, usd: 0, enrichmentCalls: 0, assetsGenerated: 0, campaignsRun: 0 },
      needsClassification: true,
      createdAt: now,
    });
    added++;
  }

  await notify({
    orgId,
    productId,
    severity: "good",
    dedupeKey: `library:import:${Date.now()}`,
    title: `Added ${added} ${added === 1 ? "person" : "people"} to the library`,
    body: [merged && `${merged} already known`, skipped && `${skipped} skipped`].filter(Boolean).join(" · ") || undefined,
    href: `/products/${productId}/library`,
  });

  revalidatePath(`/products/${productId}/library`);
}

export async function suppressPerson(productId: string, personId: string, _formData?: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const person = await db.collection(C.people).findOne({ _id: new ObjectId(personId), orgId });
  if (!person?.primaryEmail) return;

  // Suppression is permanent and lives in two places: on the person, so the library shows
  // it, and in the block list, which every ingest and every send checks.
  await db.collection(C.suppressions).updateOne(
    { orgId, identityValue: String(person.primaryEmail) },
    { $setOnInsert: { orgId, identityValue: String(person.primaryEmail), reason: "marked by hand", at: new Date() } },
    { upsert: true },
  );
  await db
    .collection(C.people)
    .updateOne({ _id: person._id }, { $set: { lifecycle: "suppressed", suppressedAt: new Date() } });
  await db
    .collection(C.goalInstances)
    .updateMany({ orgId, personId, status: "active" }, { $set: { status: "failed", outcome: "suppressed", endedAt: new Date() } });
  await db
    .collection(C.actions)
    .updateMany({ orgId, personId, status: { $in: ["queued", "awaiting_approval"] } }, { $set: { status: "skipped" } });

  revalidatePath(`/products/${productId}/library`);
}

// ── audiences ─────────────────────────────────────────────────────────────────

/** The engagement predicates a group can be built on. Anything else is ignored. */
const RESPONDED = ["clicked", "replied", "any", "never"];

export async function saveAudience(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));
  const audienceId = String(formData.get("audienceId") ?? "");
  const kind = String(formData.get("kind") ?? "dynamic");
  const now = new Date();

  const num = (key: string) => {
    const raw = String(formData.get(key) ?? "").trim();
    return raw ? Number(raw) : undefined;
  };
  const list = (key: string) => {
    const values = formData.getAll(key).map(String).filter(Boolean);
    return values.length ? values : undefined;
  };

  const doc = {
    orgId,
    productId,
    name: String(formData.get("name")).trim(),
    description: String(formData.get("description") ?? "").trim() || undefined,
    kind,
    filter:
      kind === "dynamic"
        ? {
            silentDays: num("silentDays"),
            quietDays: num("quietDays"),
            lifecycle: list("lifecycle"),
            temperature: list("temperature"),
            everEngaged: formData.get("everEngaged") === "on" ? true : undefined,
            responded: RESPONDED.includes(String(formData.get("responded")))
              ? (String(formData.get("responded")) as "clicked" | "replied" | "any" | "never")
              : undefined,
            minIcpFit: num("minIcpFit"),
            excludeSuppressed: true,
          }
        : undefined,
    personIds: kind === "static" ? formData.getAll("personIds").map(String) : [],
    updatedAt: now,
  };

  if (audienceId) {
    await db.collection(C.audiences).updateOne({ _id: new ObjectId(audienceId), orgId }, { $set: doc });
  } else {
    await db.collection(C.audiences).insertOne({ _id: new ObjectId(), ...doc, createdBy: "human", createdAt: now });
  }
  revalidatePath(`/products/${productId}/library`);
}

export async function deleteAudience(productId: string, audienceId: string, _formData?: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  await db.collection(C.audiences).deleteOne({ _id: new ObjectId(audienceId), orgId });
  revalidatePath(`/products/${productId}/library`);
}

/**
 * Creates a channel over a plain HTTP endpoint — the third way to reach people, alongside
 * SMTP and an MCP tool. A provider with a REST API and no MCP server is the common case,
 * and without this they could only ever be a source.
 */
export async function createHttpChannel(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));

  const endpointUrl = String(formData.get("endpointUrl") ?? "").trim();
  const token = String(formData.get("token") ?? "");
  if (!endpointUrl || !token) throw new Error("An endpoint and a token are both required.");

  let payloadTemplate: Record<string, unknown>;
  try {
    payloadTemplate = JSON.parse(String(formData.get("payloadTemplate") ?? "{}")) as Record<string, unknown>;
  } catch {
    throw new Error('The payload must be valid JSON, for example {"to":"$person.email"}');
  }
  if (Object.keys(payloadTemplate).length === 0) {
    throw new Error("The payload describes what to send this provider — it cannot be empty.");
  }

  const connectionId = new ObjectId();
  await db.collection(C.connections).insertOne({
    _id: connectionId,
    orgId,
    productId,
    key: "http",
    provider: String(formData.get("provider") ?? "api"),
    authType: "bearer",
    endpointUrl,
    http: {
      endpointUrl,
      method: String(formData.get("method") ?? "POST"),
      payloadTemplate,
      messageIdPath: String(formData.get("messageIdPath") ?? "").trim() || undefined,
      authHeader: String(formData.get("authHeader") ?? "").trim() || undefined,
    },
    scopes: [],
    status: "healthy",
    directions: ["out"],
    createdBy: orgId,
    createdAt: new Date(),
  });

  await db.collection(C.credentials).insertOne({
    _id: new ObjectId(),
    orgId,
    connectionId: String(connectionId),
    authType: "bearer",
    ...sealSecret(token),
    status: "verified",
  });

  await db.collection(C.channels).insertOne({
    _id: new ObjectId(),
    orgId,
    productId,
    connectionId: String(connectionId),
    key: String(formData.get("key") ?? "email"),
    kind: "native",
    from: String(formData.get("from") ?? "") || undefined,
    replyTo: String(formData.get("replyTo") ?? "") || undefined,
    // Declared honestly: an endpoint that reports nothing back should not have the planner
    // reaching for angles that depend on open rates.
    capabilities: {
      send: true,
      ...formatCapsFrom(formData),
      trackingOpens: false,
      trackingClicks: false,
      bounceWebhook: false,
      inboundReplies: false,
      consentRequired: false,
      fromDomain: "caller_controlled",
      maxSubjectLength: optionalNumber(formData, "maxSubjectLength"),
      maxBodyLength: optionalNumber(formData, "maxBodyLength"),
    },
    governor: governorFrom(formData),
    policy: { audience: ["cold", "warm_lead", "existing_user"] },
    status: "healthy",
    enabled: true,
  });

  revalidatePath(`/products/${productId}/channels`);
}

// ── routine logs ──────────────────────────────────────────────────────────────

/**
 * The raw calls behind one run, fetched only when someone opens it.
 *
 * The log page shows sixty runs; loading every call for all of them up front would be a
 * few thousand documents to render four lines of summary.
 */
export async function runCalls(runId: string): Promise<CallRow[]> {
  const orgId = await currentOrg();
  return listCalls(orgId, runId);
}

/**
 * Pauses a routine's lateness alert.
 *
 * The routine keeps running if it is still scheduled in Claude — this app cannot stop it.
 * It only says "I know this one is off", so a routine you deliberately unscheduled stops
 * ringing the bell every hour.
 */
export async function toggleRoutine(productId: string, key: string, enabled: boolean) {
  const orgId = await currentOrg();
  await setRoutineEnabled(orgId, productId, key as RoutineKey, enabled);
  revalidatePath(`/products/${productId}/claude`);
}

/** Pausing stops new people entering and holds anything queued; sent history is untouched. */
export async function toggleGoal(productId: string, key: string, enabled: boolean, _formData?: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();

  await db.collection(C.goals).updateOne({ orgId, productId, key }, { $set: { enabled } });
  // The inputs stop too, otherwise a paused campaign keeps pulling people in and queueing
  // messages that then sit there.
  await db.collection(C.sources).updateMany({ orgId, productId, defaultGoalKey: key }, { $set: { enabled } });

  if (!enabled) {
    const instances = await db
      .collection(C.goalInstances)
      .find({ orgId, productId, goalKey: key, status: "active" })
      .project({ _id: 1 })
      .toArray();
    await db.collection(C.actions).updateMany(
      { orgId, productId, goalInstanceId: { $in: instances.map((i) => String(i._id)) }, status: "queued" },
      // Held rather than skipped: resuming should not have lost the queue.
      { $set: { status: "held", heldReason: "campaign paused" } },
    );
  } else {
    await db
      .collection(C.actions)
      .updateMany({ orgId, productId, status: "held" }, { $set: { status: "queued" }, $unset: { heldReason: "" } });
  }

  revalidatePath(`/products/${productId}/goals`);
}

/**
 * Edits a campaign in place. Deliberately does not touch its inputs, its verification plan
 * or anyone already running under it — saving a form should not quietly re-ingest a
 * spreadsheet or discard checks Claude has already worked out.
 */
export async function updateGoal(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));
  const key = String(formData.get("goalKey"));
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Give the campaign a name.");

  const allowedChannels = formData.getAll("allowedChannels").map(String).filter(Boolean);
  const channels = [String(formData.get("primaryChannel") ?? "email"), String(formData.get("fallbackChannel") ?? "")]
    .map((c) => c.trim())
    .filter(Boolean);
  const allowed = allowedChannels.length > 0 ? [...new Set([...allowedChannels, ...channels])] : channels;

  const verifyConnectionId = String(formData.get("verifyConnectionId") ?? "") || undefined;
  const existing = await db.collection(C.goals).findOne({ orgId, productId, key });

  // Pointing a campaign at a different server invalidates checks written against the old
  // one, so they are cleared and Claude writes a fresh plan.
  const verifierChanged =
    verifyConnectionId !== undefined && String(existing?.verifyConnectionId ?? "") !== verifyConnectionId;

  await db.collection(C.goals).updateOne(
    { orgId, productId, key },
    {
      $set: {
        name,
        success: {
          expression: String(formData.get("successExpression") ?? existing?.success?.expression ?? "account_created"),
          describedAs: String(formData.get("successDescribed")),
        },
        budget: {
          touches: Number(formData.get("touches") ?? 9),
          days: Number(formData.get("days") ?? 30),
          // The form no longer asks for these, so an edit must keep what is already set
          // rather than resetting it to the default every time somebody renames a campaign.
          usd: Number(formData.get("usd") ?? existing?.budget?.usd ?? 12),
        },
        allowedChannels: allowed,
        verifyConnectionId,
        verifyHint: String(formData.get("verifyHint") ?? existing?.verifyHint ?? "").trim() || undefined,
        firstTouch: { templateKey: String(formData.get("firstTouchTemplate")), channels },
        "schedule.approvalMode": String(formData.get("approvalMode") ?? "gate_on"),
        "failure.silenceDays": Number(formData.get("silenceDays") ?? existing?.failure?.silenceDays ?? 30),
        ...(verifierChanged ? { checks: [], needsVerificationPlan: true } : {}),
      },
    },
  );

  revalidatePath(`/products/${productId}/goals`);
}

/**
 * Recomputes the derived alerts behind the bell and the dashboard band. The engine does
 * this on its own clock; this is the button for when somebody has just fixed the thing
 * being complained about and wants the page to agree.
 */
export async function refreshDashboard(productId: string, _formData?: FormData) {
  const orgId = await currentOrg();
  await refreshDerived(orgId, productId);
  revalidatePath(`/products/${productId}`);
}

// ── templates ─────────────────────────────────────────────────────────────────

/** A new block starts with everything it needs to render, so the preview is never empty. */
function blankBlock(type: string): Record<string, unknown> {
  switch (type) {
    case "subject":
      return { type: "subject", slot: "one line, under 55 characters", fallback: "{{first_name}}, a quick one" };
    case "preheader":
      return { type: "preheader", fallback: "The line the inbox shows next to the subject." };
    case "heading":
      return { type: "heading", level: 1, fixed: "A headline worth the open" };
    case "text":
      return { type: "text", fixed: "Hi {{first_name}}," };
    case "slot":
      return { type: "slot", instruct: "Two sentences, specific to this person.", fallback: "Here is what changes for your team this week." };
    case "list":
      return { type: "list", style: "check", items: ["First point", "Second point"] };
    case "card":
      return { type: "card", rows: [{ label: "Plan", value: "Starter" }], accent: false };
    case "callout":
      return { type: "callout", fixed: "One line worth setting apart." };
    case "divider":
      return { type: "divider" };
    case "image":
      return { type: "image", url: "https://example.com/image.png", alt: "" };
    case "cta":
      return { type: "cta", fixed: "Get started", url: "{{trial_link}}" };
    case "system":
      return { type: "system", fixed: "opt_out_block" };
    default:
      throw new Error(`unknown block type "${type}"`);
  }
}

async function loadTemplate(productId: string, templateId: string) {
  const db = await getDb();
  const orgId = await currentOrg();
  const doc = await db
    .collection(C.templates)
    .findOne({ _id: new ObjectId(templateId), orgId, productId });
  if (!doc) throw new Error("template not found");
  return { db, orgId, doc };
}

function refreshTemplate(productId: string, templateId: string) {
  revalidatePath(`/products/${productId}/templates`);
  revalidatePath(`/products/${productId}/templates/${templateId}`);
}

export async function createTemplate(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));
  const name = String(formData.get("name") ?? "").trim() || "Untitled";
  const channel = String(formData.get("channel") ?? "email");
  const scope = String(formData.get("scope") ?? "product_default");
  const segmentKey = String(formData.get("segmentKey") ?? "").trim();
  const key = slugify(String(formData.get("key") ?? "").trim() || name);

  const isEmail = channel === "email";
  const blocks: Record<string, unknown>[] = isEmail
    ? [
        blankBlock("subject"),
        blankBlock("preheader"),
        blankBlock("heading"),
        blankBlock("text"),
        blankBlock("slot"),
        blankBlock("cta"),
        blankBlock("system"),
      ]
    : [blankBlock("slot"), blankBlock("cta")];

  const templateId = new ObjectId();
  await db.collection(C.templates).insertOne({
    _id: templateId,
    orgId,
    productId,
    key,
    name,
    channel,
    // Short-form channels have no HTML to speak of, so they are text by definition.
    format: isEmail ? (String(formData.get("format") ?? "html") === "text" ? "text" : "html") : "text",
    stage: String(formData.get("stage") ?? "first_touch"),
    scope,
    ...(scope === "segment" && segmentKey ? { segmentKey } : {}),
    version: 1,
    blocks,
    constraints: { maxWords: isEmail ? 140 : 45, noClaims: [] },
    assetIds: [],
    stats: { sent: 0, replied: 0, converted: 0, alpha: 1, beta: 1 },
    // New work starts as a draft. A template that begins active would join the cascade
    // before anyone has read it once.
    status: "draft",
    createdBy: "human",
  });

  redirect(`/products/${productId}/templates/${String(templateId)}`);
}

export async function duplicateTemplate(productId: string, templateId: string, _formData?: FormData) {
  const { db, orgId, doc } = await loadTemplate(productId, templateId);
  const copyId = new ObjectId();
  const { _id: _ignored, ...rest } = doc;
  await db.collection(C.templates).insertOne({
    ...rest,
    _id: copyId,
    orgId,
    name: `${String(doc.name ?? doc.key)} copy`,
    key: `${String(doc.key)}-copy`,
    parentId: templateId,
    version: 1,
    stats: { sent: 0, replied: 0, converted: 0, alpha: 1, beta: 1 },
    status: "draft",
    createdBy: "human",
  });
  redirect(`/products/${productId}/templates/${String(copyId)}`);
}

export async function deleteTemplate(productId: string, templateId: string, _formData?: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  // Queued mail names its template and renders from it at send time, so removing one out
  // from under a pending touch would fail that send hours later, in the engine.
  const pending = await db
    .collection(C.actions)
    .countDocuments({ orgId, productId, templateId, status: { $in: ["queued", "awaiting_approval", "sending"] } });
  if (pending > 0) {
    throw new Error(`${pending} message${pending === 1 ? " is" : "s are"} still queued against this template`);
  }

  await db.collection(C.templates).deleteOne({ _id: new ObjectId(templateId), orgId, productId });
  revalidatePath(`/products/${productId}/templates`);
  redirect(`/products/${productId}/templates`);
}

export async function saveTemplateMeta(formData: FormData) {
  const productId = String(formData.get("productId"));
  const templateId = String(formData.get("templateId"));
  const { db, orgId } = await loadTemplate(productId, templateId);

  const maxWords = Number(formData.get("maxWords"));
  const noClaims = String(formData.get("noClaims") ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  await db.collection(C.templates).updateOne(
    { _id: new ObjectId(templateId), orgId, productId },
    {
      $set: {
        name: String(formData.get("name") ?? "").trim() || "Untitled",
        stage: String(formData.get("stage") ?? "first_touch"),
        status: String(formData.get("status") ?? "draft"),
        format: String(formData.get("format") ?? "html") === "text" ? "text" : "html",
        "constraints.maxWords": Number.isFinite(maxWords) && maxWords > 0 ? Math.round(maxWords) : undefined,
        "constraints.noClaims": noClaims,
      },
    },
  );
  refreshTemplate(productId, templateId);
}

export async function addTemplateBlock(formData: FormData) {
  const productId = String(formData.get("productId"));
  const templateId = String(formData.get("templateId"));
  const { db, orgId } = await loadTemplate(productId, templateId);
  await db
    .collection(C.templates)
    .updateOne(
      { _id: new ObjectId(templateId), orgId, productId },
      { $push: { blocks: blankBlock(String(formData.get("type"))) } as never },
    );
  refreshTemplate(productId, templateId);
}

export async function removeTemplateBlock(productId: string, templateId: string, index: number, _formData?: FormData) {
  const { db, orgId, doc } = await loadTemplate(productId, templateId);
  const blocks = (doc.blocks as unknown[]).filter((_, at) => at !== index);
  if (blocks.length === 0) throw new Error("a template needs at least one block");
  await db
    .collection(C.templates)
    .updateOne({ _id: new ObjectId(templateId), orgId, productId }, { $set: { blocks } });
  refreshTemplate(productId, templateId);
}

export async function moveTemplateBlock(
  productId: string,
  templateId: string,
  index: number,
  direction: -1 | 1,
  _formData?: FormData,
) {
  const { db, orgId, doc } = await loadTemplate(productId, templateId);
  const blocks = [...(doc.blocks as unknown[])];
  const target = index + direction;
  if (target < 0 || target >= blocks.length) return;
  [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
  await db
    .collection(C.templates)
    .updateOne({ _id: new ObjectId(templateId), orgId, productId }, { $set: { blocks } });
  refreshTemplate(productId, templateId);
}

/** Rebuilds one block from the editor's fields. Unknown fields are dropped, not stored. */
export async function updateTemplateBlock(formData: FormData) {
  const productId = String(formData.get("productId"));
  const templateId = String(formData.get("templateId"));
  const index = Number(formData.get("index"));
  const { db, orgId, doc } = await loadTemplate(productId, templateId);

  const blocks = [...(doc.blocks as Record<string, unknown>[])];
  const current = blocks[index];
  if (!current) throw new Error("that block no longer exists");

  const text = (field: string) => {
    const value = formData.get(field);
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed || undefined;
  };
  const lines = (field: string) =>
    String(formData.get(field) ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  const type = String(current.type);
  let next: Record<string, unknown>;

  switch (type) {
    case "subject":
      next = { type, slot: text("slot") ?? "one line", fallback: text("fallback") };
      break;
    case "preheader":
      next = { type, slot: text("slot"), fallback: text("fallback") };
      break;
    case "text":
    case "callout":
      next = { type, fixed: text("fixed") ?? "" };
      break;
    case "slot":
      next = { type, name: text("name"), instruct: text("instruct") ?? "", fallback: text("fallback") };
      break;
    case "heading":
      next = {
        type,
        level: Math.min(3, Math.max(1, Number(formData.get("level") ?? 1))),
        fixed: text("fixed"),
        slot: text("slot"),
        fallback: text("fallback"),
      };
      break;
    case "list":
      next = { type, style: String(formData.get("style") ?? "bullet"), items: lines("items") };
      break;
    case "card":
      next = {
        type,
        title: text("title"),
        accent: formData.get("accent") === "on",
        // One row per line, label and value split on the first pipe.
        rows: lines("rows").map((line) => {
          const [label, ...rest] = line.split("|");
          return { label: (label ?? "").trim(), value: rest.join("|").trim() };
        }),
      };
      break;
    case "image":
      next = {
        type,
        url: text("url") ?? "",
        alt: text("alt") ?? "",
        width: Number(formData.get("width")) || undefined,
        href: text("href"),
      };
      break;
    case "cta":
      next = { type, fixed: text("fixed") ?? "Get started", url: text("url") ?? "{{trial_link}}" };
      break;
    default:
      next = current;
  }

  blocks[index] = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
  await db
    .collection(C.templates)
    .updateOne({ _id: new ObjectId(templateId), orgId, productId }, { $set: { blocks } });
  refreshTemplate(productId, templateId);
}

// ── brand ─────────────────────────────────────────────────────────────────────

/**
 * Reads the brand off the product's own website. This exists so a tenant who has
 * connected nothing still sends mail in their own colours — a dedicated brand provider is
 * an upgrade on this, never a precondition for it.
 */
export async function detectBrandFromWebsite(productId: string, _formData?: FormData) {
  const orgId = await currentOrg();
  const { ensureWebsiteBrandSource, refreshBrandSource } = await import("@/engine/brand.js");
  await ensureWebsiteBrandSource(orgId, productId);

  const db = await getDb();
  const source = await db.collection(C.brandSources).findOne({ orgId, productId, kind: "css_vars" });
  if (!source) throw new Error("this product has no website in its config yet");
  await refreshBrandSource(String(source._id));
  revalidatePath(`/products/${productId}/brand`);
}

export async function addBrandSource(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));
  const kind = String(formData.get("kind"));
  const url = String(formData.get("url") ?? "").trim();
  const connectionId = String(formData.get("connectionId") ?? "").trim();

  if ((kind === "css_vars" || kind === "http_tokens") && !url) throw new Error("a URL is required");
  if (kind === "mcp_brand" && !connectionId) throw new Error("choose a connection");

  await db.collection(C.brandSources).insertOne({
    _id: new ObjectId(),
    orgId,
    productId,
    name: String(formData.get("name") ?? "").trim() || kind,
    kind,
    ...(url ? { url } : {}),
    ...(connectionId ? { connectionId } : {}),
    tokenMap: {},
    // Lower numbers lose on conflict, so a hand-typed override sits above anything fetched.
    precedence: Number(formData.get("precedence")) || (kind === "mcp_brand" ? 50 : 20),
    refreshEverySec: kind === "css_vars" ? 604_800 : 86_400,
    enabled: true,
  });

  const created = await db.collection(C.brandSources).findOne({ orgId, productId, kind }, { sort: { _id: -1 } });
  if (created) {
    const { refreshBrandSource } = await import("@/engine/brand.js");
    // Fetch immediately: a source added and left blank until the next tick looks broken.
    try {
      await refreshBrandSource(String(created._id));
    } catch {
      // The health field on the source now carries the reason; the page shows it.
    }
  }
  revalidatePath(`/products/${productId}/brand`);
}

export async function refreshBrand(productId: string, sourceId: string, _formData?: FormData) {
  const { refreshBrandSource } = await import("@/engine/brand.js");
  try {
    await refreshBrandSource(sourceId);
  } catch {
    // Recorded on the source. Throwing here would replace the page with a crash screen.
  }
  revalidatePath(`/products/${productId}/brand`);
}

export async function deleteBrandSource(productId: string, sourceId: string, _formData?: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  await db.collection(C.brandSources).deleteOne({ _id: new ObjectId(sourceId), orgId, productId });
  const { rebuildKit } = await import("@/engine/brand.js");
  await rebuildKit(orgId, productId);
  revalidatePath(`/products/${productId}/brand`);
}

/**
 * The hand-entered overrides. Stored as one `manual` source at the top of the precedence
 * order rather than written into the kit, so a brand refresh can never overwrite a value
 * somebody typed on purpose.
 */
export async function saveManualBrand(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));

  const value = (field: string) => {
    const raw = String(formData.get(field) ?? "").trim();
    return raw || undefined;
  };
  const colour = (field: string) => {
    const raw = value(field);
    return raw && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw) ? raw.toLowerCase() : undefined;
  };

  const gradient = String(formData.get("gradient") ?? "")
    .split(",")
    .map((stop) => stop.trim().toLowerCase())
    .filter((stop) => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(stop));

  const literal: Record<string, unknown> = {};
  const color: Record<string, unknown> = {};
  for (const field of ["bg", "surface", "text", "muted", "border", "accent", "accentText"]) {
    const found = colour(field);
    if (found) color[field] = found;
  }
  if (gradient.length >= 2) color.gradient = gradient.slice(0, 3);
  if (Object.keys(color).length) literal.color = color;

  const logoUrl = value("logoUrl");
  if (logoUrl) {
    literal.logo = {
      light: logoUrl,
      alt: value("logoAlt") ?? "",
      width: Number(formData.get("logoWidth")) || 132,
      ...(value("logoHref") ? { href: value("logoHref") } : {}),
    };
  }

  const heading = value("headingStack");
  const body = value("bodyStack");
  if (heading || body) literal.font = { ...(heading ? { headingStack: heading } : {}), ...(body ? { bodyStack: body } : {}) };

  const legalName = value("legalName");
  const address = value("address");
  const disclaimer = value("disclaimer");
  if (legalName || address || disclaimer) {
    literal.footer = {
      ...(legalName ? { legalName } : {}),
      ...(address ? { address } : {}),
      ...(disclaimer ? { disclaimer } : {}),
    };
  }

  await db.collection(C.brandSources).updateOne(
    { orgId, productId, kind: "manual" },
    {
      $set: {
        orgId,
        productId,
        name: "Typed by hand",
        kind: "manual",
        literal,
        resolved: literal,
        tokenMap: {},
        precedence: 90,
        refreshEverySec: 31_536_000,
        enabled: true,
        lastRunAt: new Date(),
        health: { status: "healthy" },
      },
      $setOnInsert: { _id: new ObjectId() },
    },
    { upsert: true },
  );

  const { rebuildKit } = await import("@/engine/brand.js");
  await rebuildKit(orgId, productId);
  revalidatePath(`/products/${productId}/brand`);
  revalidatePath(`/products/${productId}/templates`);
}

/**
 * Assets: the things we can show a person that are not sentences.
 *
 * One writer for both create and edit, because an asset is small enough that the two forms
 * are the same form. The key is derived from the name and then frozen — Claude refers to an
 * asset by key in its rationale, and a key that moved when somebody renamed a file would
 * make every earlier rationale point at nothing.
 */
export async function saveAsset(formData: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  const productId = String(formData.get("productId"));
  const assetId = String(formData.get("assetId") ?? "").trim();

  const text = (field: string) => String(formData.get(field) ?? "").trim();
  const list = (field: string, sep: RegExp) =>
    text(field).split(sep).map((v) => v.trim()).filter(Boolean);

  const name = text("name") || "Untitled";
  const kind = text("kind") || "image";

  // An expiry is a day, not an instant: "good until the 30th" means through the 30th in the
  // reader's day, so it lands at the end of that day in IST rather than at its midnight.
  const expiresOn = text("expiresAt");
  const expiresAt = expiresOn ? fromIstInput(`${expiresOn}T23:59`) : undefined;

  const doc = {
    orgId,
    productId,
    name,
    kind,
    tier: text("tier") || "C",
    file:
      kind === "quote" || kind === "stat" || kind === "access"
        ? undefined
        : {
            url: text("url"),
            thumbUrl: text("thumbUrl") || undefined,
            durationSec: Number(formData.get("durationSec") ?? 0) || undefined,
          },
    access:
      kind === "access"
        ? {
            bookingUrl: text("bookingUrl") || undefined,
            repName: text("repName") || undefined,
            repRole: text("repRole") || undefined,
            repEmail: text("repEmail") || undefined,
            repPhone: text("repPhone") || undefined,
            availability: text("availability") || undefined,
          }
        : undefined,
    text: text("text") || undefined,
    attribution: text("attribution") || undefined,

    // The three sentences the whole feature turns on. Required by the schema, so an asset
    // that a model could not choose between cannot be saved in the first place.
    useWhen: text("useWhen"),
    proves: text("proves"),
    oneLine: text("oneLine"),

    claims: list("claims", /\n+/),
    forSegment: formData.getAll("forSegment").map(String).filter(Boolean),
    answers: list("answers", /,/),
    tags: list("tags", /,/),
    language: text("language") || "en",
    channels: formData.getAll("channels").map(String).filter(Boolean),
    requiresApproval: formData.get("requiresApproval") === "on",
    expiresAt,
    origin: "human" as const,
    status: text("status") || "draft",
  };

  // Validated against the schema rather than trusted, because this is the one document in
  // the system a model reads to make a choice. An asset missing `proves` would sit in every
  // menu forever as a row nothing can pick.
  const existing = assetId
    ? await db.collection(C.assets).findOne({ _id: new ObjectId(assetId), orgId, productId })
    : null;
  // Keys are unique per product and a name like "Demo" is one people reach for twice. A
  // second one takes `demo_2` rather than failing on the index with a Mongo error nobody
  // reading this form could act on.
  const key = existing ? String(existing.key) : await freeAssetKey(orgId, productId, slugify(text("key") || name));
  const parsed = asset.parse({
    ...doc,
    key,
    usage: existing?.usage ?? {},
    createdAt: existing?.createdAt ?? new Date(),
  });

  if (existing) {
    // `usage` and `createdAt` are the asset's history and are never rewritten by a save.
    const { usage: _usage, createdAt: _createdAt, ...editable } = parsed;
    await db.collection(C.assets).updateOne({ _id: existing._id }, { $set: editable });
  } else {
    await db.collection(C.assets).insertOne({ ...parsed, createdBy: (await requireSession()).userId });
  }

  revalidatePath(`/products/${productId}/assets`);
}

/** The first unused key in the `demo`, `demo_2`, `demo_3` series. */
async function freeAssetKey(orgId: string, productId: string, base: string): Promise<string> {
  const db = await getDb();
  const stem = base || "asset";
  for (let n = 1; n < 100; n += 1) {
    const candidate = n === 1 ? stem : `${stem}_${n}`;
    const taken = await db.collection(C.assets).countDocuments({ orgId, productId, key: candidate });
    if (!taken) return candidate;
  }
  return `${stem}_${Date.now()}`;
}

/** Draft ⇄ active ⇄ archived. Only active assets reach a menu. */
export async function setAssetStatus(productId: string, assetId: string, status: string, _formData?: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  await db
    .collection(C.assets)
    .updateOne({ _id: new ObjectId(assetId), orgId, productId }, { $set: { status } });
  revalidatePath(`/products/${productId}/assets`);
}

/**
 * Refused while any unsent message still names it.
 *
 * A queued or held action carries asset ids, and the block is rendered from the asset at
 * send time — deleting one underneath a message that is waiting in Review turns it into a
 * gap nobody notices until the recipient reads it. Archiving takes it out of every future
 * menu and leaves the messages already written intact, which is what people mean.
 */
export async function deleteAsset(productId: string, assetId: string, _formData?: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();

  const pending = await db.collection(C.actions).countDocuments({
    orgId,
    productId,
    assetIds: assetId,
    status: { $in: ["queued", "held", "awaiting_approval", "sending"] },
  });
  if (pending > 0) {
    await setAssetStatus(productId, assetId, "archived");
    return;
  }

  await db.collection(C.assets).deleteOne({ _id: new ObjectId(assetId), orgId, productId });
  revalidatePath(`/products/${productId}/assets`);
}
