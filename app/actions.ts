"use server";

import { ObjectId } from "mongodb";
import { requiredArgs } from "@/mcp/argcheck.js";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { sealSecret } from "@/crypto/envelope.js";
import { resolveSecret } from "@/crypto/broker.js";
import { McpClient, hashTools } from "@/mcp/client.js";
import { inferCapabilities } from "@/mcp/discover.js";
import { buildAuthorizeUrl, createPkce, discoverAuthServer, randomState, registerClient } from "@/mcp/oauth.js";
import { headers } from "next/headers";
import { productConfig } from "@/schemas/product.js";
import { notify, refreshDerived } from "@/engine/notify.js";
import { listCalls, type CallRow, type RoutineKey } from "@/engine/runlog.js";
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
  if (!serverUrl || !token) throw new Error("Server URL and token are both required");

  const connectionId = new ObjectId();
  await db.collection(C.connections).insertOne({
    _id: connectionId,
    orgId: (await currentOrg()),
    productId,
    key: provider,
    provider,
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

/** Lists the server's tools and records what can be inferred. Never binds automatically. */
export async function discoverTools(productId: string, connectionId: string) {
  const db = await getDb();
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
  if (!connection?.serverUrl) throw new Error("connection not found");

  const token = await resolveSecret((await currentOrg()), connectionId, "ui.discover");
  const client = new McpClient(String(connection.serverUrl), token);

  let tools;
  try {
    tools = await client.listTools();
  } catch (err) {
    // Surface the failure on the connection rather than throwing a crash page — a server
    // that speaks a dialect we cannot read is a normal thing to have to diagnose.
    const message = err instanceof Error ? err.message : String(err);
    await db
      .collection(C.connections)
      .updateOne({ _id: new ObjectId(connectionId) }, { $set: { status: "degraded", lastError: message } });
    revalidatePath(`/products/${productId}/connections/${connectionId}`);
    return;
  }

  await db.collection(C.mcpBindings).updateOne(
    { orgId: (await currentOrg()), connectionId },
    {
      $set: {
        orgId: (await currentOrg()),
        connectionId,
        discoveredTools: tools,
        capabilities: inferCapabilities(tools),
        toolsHash: hashTools(tools),
        discoveredAt: new Date(),
      },
      $setOnInsert: { bind: {} },
    },
    { upsert: true },
  );
  await db
    .collection(C.connections)
    .updateOne(
      { _id: new ObjectId(connectionId) },
      { $set: { status: "verifying", lastVerifiedAt: new Date() }, $unset: { lastError: "" } },
    );

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
      maxSubjectLength: Number(formData.get("maxSubjectLength") ?? 0) || undefined,
      maxBodyLength: Number(formData.get("maxBodyLength") ?? 0) || undefined,
    },
    governor: {
      dailyCap: Number(formData.get("dailyCap") ?? 50),
      perMinute: Number(formData.get("perMinute") ?? 0) || undefined,
      perHour: Number(formData.get("perHour") ?? 0) || undefined,
      warmupDay: 1,
      sentToday: 0,
      windowStartedAt: new Date(),
    },
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

  let fieldMap: Record<string, string> = { email: "email", name: "name" };
  const raw = String(formData.get("fieldMap") ?? "").trim();
  if (raw) {
    try {
      fieldMap = JSON.parse(raw) as Record<string, string>;
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

  let fieldMap: Record<string, string> = { email: "email", name: "name" };
  const rawMap = String(formData.get("fieldMap") ?? "").trim();
  if (rawMap) {
    try {
      fieldMap = JSON.parse(rawMap) as Record<string, string>;
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

    await db
      .collection(C.mcpBindings)
      .updateOne(
        { orgId: (await currentOrg()), connectionId },
        { $set: { "bind.fetch_leads": { tool, args: { cursor: "$cursor" } } } },
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
    });

    const { runSource } = await import("@/engine/runSource.js");
    await runSource(String(sourceId), rows);
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
    createdBy: (await currentOrg()),
    createdAt: new Date(),
  });

  redirect(
    buildAuthorizeUrl({ metadata, clientId, redirectUri, challenge, state, resource: serverUrl }),
  );
}

/** Reports whether a server can be connected by OAuth, before anyone commits to a path. */
export async function probeAuth(formData: FormData): Promise<void> {
  const serverUrl = String(formData.get("serverUrl") ?? "").trim();
  const productId = String(formData.get("productId"));
  const metadata = await discoverAuthServer(serverUrl);
  const supported = Boolean(metadata?.authorization_endpoint);
  const dcr = Boolean(metadata?.registration_endpoint);
  redirect(
    `/products/${productId}/connections/new?probed=${encodeURIComponent(serverUrl)}&oauth=${supported}&dcr=${dcr}`,
  );
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

  const [channels, sources] = await Promise.all([
    db.collection(C.channels).countDocuments({ orgId: (await currentOrg()), connectionId }),
    db.collection(C.sources).countDocuments({ orgId: (await currentOrg()), connectionId }),
  ]);
  if (channels > 0 || sources > 0) {
    throw new Error(
      `In use by ${channels} channel(s) and ${sources} source(s). Remove those first.`,
    );
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
    // SMTP delivers but reports nothing back. Declaring that honestly makes the planner
    // drop open-rate-dependent angles instead of scoring every lead as never-opened.
    capabilities: {
      send: true,
      html: true,
      trackingOpens: false,
      trackingClicks: false,
      bounceWebhook: false,
      inboundReplies: false,
      consentRequired: false,
      fromDomain: "caller_controlled",
    },
    governor: {
      dailyCap: Number(formData.get("dailyCap") ?? 50),
      warmupDay: 1,
      sentToday: 0,
      windowStartedAt: new Date(),
    },
    policy: { audience: ["cold", "warm_lead", "existing_user"] },
    status: "healthy",
    enabled: true,
  });

  revalidatePath(`/products/${productId}/channels`);
}

export async function deleteChannel(productId: string, channelId: string, _formData?: FormData) {
  const db = await getDb();
  await db.collection(C.channels).deleteOne({ _id: new ObjectId(channelId), orgId: (await currentOrg()) });
  revalidatePath(`/products/${productId}/channels`);
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
  // The reviewer is looking at the designed mail; sending it as plain text is their call
  // to make here, on the message in front of them, not a template-wide setting.
  const asText = String(formData.get("format") ?? "html") === "text";

  await db.collection(C.actions).updateMany(
    { _id: { $in: ids }, orgId, productId, status: "awaiting_approval" },
    // Approving returns it to the queue rather than sending directly, so budgets, caps and
    // suppression are all still checked at the moment it actually goes out.
    {
      $set: { status: approve ? "queued" : "skipped", reviewedAt: new Date(), format: asText ? "text" : "html" },
      // Dropping the rendered HTML is not enough on its own — the sender rebuilds it from
      // the template when it is missing, so the choice is recorded on the action too.
      ...(approve && asText ? { $unset: { "content.bodyHtml": "" } } : {}),
    },
  );

  revalidatePath(`/products/${productId}/review`, "layout");
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
      html: true,
      trackingOpens: false,
      trackingClicks: false,
      bounceWebhook: false,
      inboundReplies: false,
      consentRequired: false,
      fromDomain: "caller_controlled",
      maxSubjectLength: Number(formData.get("maxSubjectLength") ?? 0) || undefined,
      maxBodyLength: Number(formData.get("maxBodyLength") ?? 0) || undefined,
    },
    governor: {
      dailyCap: Number(formData.get("dailyCap") ?? 50),
      perMinute: Number(formData.get("perMinute") ?? 0) || undefined,
      perHour: Number(formData.get("perHour") ?? 0) || undefined,
      warmupDay: 1,
      sentToday: 0,
      windowStartedAt: new Date(),
    },
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
