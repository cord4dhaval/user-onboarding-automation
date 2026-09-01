"use server";

import { ObjectId } from "mongodb";
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
import { notify } from "@/engine/notify.js";
import { requireSession } from "./tenant";

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

export async function createChannel(formData: FormData) {
  const db = await getDb();
  const productId = String(formData.get("productId"));
  const connectionId = String(formData.get("connectionId"));

  await db.collection(C.channels).insertOne({
    _id: new ObjectId(),
    orgId: (await currentOrg()),
    productId,
    connectionId,
    key: String(formData.get("key")),
    kind: "mcp",
    from: String(formData.get("from") ?? "") || undefined,
    // Taken from the connection's discovered capabilities, so the planner never proposes
    // an angle this channel cannot actually support.
    capabilities: {
      ...(await capabilitiesFor(connectionId)),
      maxSubjectLength: Number(formData.get("maxSubjectLength") ?? 0) || undefined,
      maxBodyLength: Number(formData.get("maxBodyLength") ?? 0) || undefined,
    },
    replyTo: String(formData.get("replyTo") ?? "") || undefined,
    // The provider's own published limits, enforced by the engine before every send.
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
  const key = String(formData.get("key"));

  // A campaign with no input never starts, and one with no way to check itself runs to its
  // budget and closes as "unverified" a month later. Both failures are silent, so both are
  // refused here rather than discovered long afterwards.
  if (String(formData.get("inputType") ?? "none") === "none") {
    throw new Error("This campaign needs an input — a spreadsheet, an audience, an MCP tool or an API.");
  }

  let checks: unknown[] = [];
  const rawChecks = String(formData.get("checks") ?? "").trim();
  if (rawChecks) {
    try {
      checks = JSON.parse(rawChecks) as unknown[];
    } catch {
      throw new Error("The verification plan is not valid JSON.");
    }
  }
  if (checks.length === 0) {
    throw new Error(
      "This campaign needs a way to know when someone has succeeded. Ask Claude to propose one from your connected sources, or write the checks yourself.",
    );
  }
  // A priority chain, built from two explicit choices rather than a free-text list —
  // exactly one channel carries a touch, and the order has to be unambiguous.
  const channels = [String(formData.get("primaryChannel") ?? "email"), String(formData.get("fallbackChannel") ?? "")]
    .map((c) => c.trim())
    .filter(Boolean);

  await db.collection(C.goals).updateOne(
    { orgId: (await currentOrg()), productId, key },
    {
      $set: {
        orgId: (await currentOrg()),
        productId,
        key,
        name: String(formData.get("name")),
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
        checks,
        // A priority order, not a broadcast list — exactly one channel carries a touch.
        firstTouch: { templateKey: String(formData.get("firstTouchTemplate")), channels },
        schedule: {
          fetchEverySec: Number(formData.get("fetchEverySec") ?? 600),
          tickEverySec: Number(formData.get("tickEverySec") ?? 600),
          bufferDepth: 3,
          approvalMode: String(formData.get("approvalMode") ?? "gate_on"),
        },
        cadenceByTemp: {
          hot: { minGapDays: 2, maxGapDays: 3, maxAssetTier: "C" },
          warm: { minGapDays: 4, maxGapDays: 6, maxAssetTier: "C" },
          cold: { minGapDays: 8, maxGapDays: 12, maxAssetTier: "A" },
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

/** Creates whichever input the goal form selected, if any. */
async function attachInput(formData: FormData, productId: string, goalKey: string): Promise<void> {
  const db = await getDb();
  const inputType = String(formData.get("inputType") ?? "none");
  if (inputType === "none") return;

  const intervalSec = Number(formData.get("intervalSec") ?? 600);
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
    name: String(formData.get("inputName") ?? goalKey),
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

    await db.collection(C.sources).insertOne({
      _id: new ObjectId(),
      ...base,
      connectionId: "",
      kind: "audience",
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

    await db.collection(C.sources).insertOne({
      _id: new ObjectId(),
      ...base,
      connectionId,
      kind: "mcp_source",
    });
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
    await db.collection(C.sources).insertOne({
      _id: new ObjectId(),
      ...base,
      connectionId: String(connectionId),
      kind: "api_pull",
      cursorParam: String(formData.get("cursorParam") ?? "") || undefined,
    });
    return;
  }

  if (inputType === "file") {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new Error("Choose a spreadsheet to upload");

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

  await db.collection(C.actions).updateMany(
    { _id: { $in: ids }, orgId, productId, status: "awaiting_approval" },
    // Approving returns it to the queue rather than sending directly, so budgets, caps and
    // suppression are all still checked at the moment it actually goes out.
    { $set: { status: approve ? "queued" : "skipped", reviewedAt: new Date() } },
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
  revalidatePath(`/products/${productId}/audiences`);
}

export async function deleteAudience(productId: string, audienceId: string, _formData?: FormData) {
  const db = await getDb();
  const orgId = await currentOrg();
  await db.collection(C.audiences).deleteOne({ _id: new ObjectId(audienceId), orgId });
  revalidatePath(`/products/${productId}/audiences`);
}
