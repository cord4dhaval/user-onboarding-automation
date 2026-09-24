import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { sealSecret } from "../crypto/envelope.js";
import { appOrigin } from "../engine/vars.js";

const GRAPH = "https://graph.facebook.com/v23.0";
const DIALOG = "https://www.facebook.com/v23.0/dialog/oauth";

/**
 * The Meta app this deployment signs businesses in through.
 *
 * Ours, not the tenant's. Embedded Signup is a flow our app runs on their account, which is
 * the point: the alternative is walking every customer through a system user, asset
 * assignment and a token generator that a second admin has to approve.
 */
export function metaApp(): { id: string; secret: string; configId: string; signupUrl: string } {
  const id = process.env.META_APP_ID ?? "";
  const secret = process.env.META_APP_SECRET ?? "";
  if (!id || !secret) throw new Error("WhatsApp sign-in is not configured on this deployment.");
  return {
    id,
    secret,
    configId: process.env.META_LOGIN_CONFIG_ID ?? "",
    signupUrl: process.env.META_SIGNUP_URL ?? "",
  };
}

/**
 * The one address Meta redirects back to, used twice and identical both times.
 *
 * Meta compares the value sent to the dialog with the value sent to the token exchange and
 * refuses the code where they differ, so neither caller is allowed to spell it out itself.
 * It is also the exact string that has to be listed as a valid OAuth redirect URI on the
 * Meta app, which is why it is built from APP_URL rather than from the request.
 */
export function metaRedirectUri(): string {
  return `${appOrigin()}/api/oauth/meta/callback`;
}

/**
 * Where a business is sent to sign in.
 *
 * Built here rather than pasted into an environment variable, because the dialog only hands
 * a code back to us when four things are right at once: the login configuration, a code
 * response type, the override that makes a Login-for-Business config return one, and a
 * redirect URI matching the exchange. A hand-written link that misses one of them completes
 * on Meta's side and returns nobody, which reads as the sign-in doing nothing.
 *
 * META_SIGNUP_URL still wins where it is set, for a deployment handed a link by Meta.
 */
export function metaSignInUrl(state: string): string {
  const app = metaApp();
  if (app.signupUrl) {
    return `${app.signupUrl}${app.signupUrl.includes("?") ? "&" : "?"}state=${encodeURIComponent(state)}`;
  }
  if (!app.configId) return "";
  const url = new URL(DIALOG);
  url.searchParams.set("client_id", app.id);
  url.searchParams.set("config_id", app.configId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("override_default_response_type", "true");
  url.searchParams.set("redirect_uri", metaRedirectUri());
  url.searchParams.set("state", state);
  return url.toString();
}

/** Meta's error message from a Graph response, without echoing the body back. */
async function reasonFrom(response: Response): Promise<string> {
  const said = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
  return said.error?.message ?? `HTTP ${response.status}`;
}

/**
 * Trades the code the flow hands back for a business token.
 *
 * Always here, never in the browser: the token is the credential for someone's WhatsApp
 * account, and a page that has held one has leaked it. The code is worth 30 seconds, so
 * this runs the moment the redirect lands.
 */
export async function exchangeMetaCode(code: string): Promise<string> {
  const app = metaApp();
  // redirect_uri belongs here whenever the code arrived on a redirect. The popup flow this
  // replaced did not send one, and Meta answers a redirect code without it by refusing the
  // exchange outright rather than by naming the missing field.
  const url = `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(app.id)}&client_secret=${encodeURIComponent(app.secret)}&redirect_uri=${encodeURIComponent(metaRedirectUri())}&code=${encodeURIComponent(code)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const granted = (await response.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
  if (!response.ok || !granted.access_token) {
    throw new Error(`WhatsApp sign-in failed: ${granted.error?.message ?? `HTTP ${response.status}`}`);
  }
  return granted.access_token;
}

/**
 * Which account and number the business actually granted, read from the token itself.
 *
 * The in-page flow reports these through browser messages, which arrive before the code and
 * are missed if the listener was not mounted in time. The token cannot be wrong about what
 * it was granted, so this is the version that runs on a redirect.
 */
export async function metaAssetsFor(token: string): Promise<{ wabaId: string; phoneNumberId: string }> {
  const app = metaApp();
  const debug = await fetch(
    `${GRAPH}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(`${app.id}|${app.secret}`)}`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!debug.ok) throw new Error(`The sign-in token could not be read: ${await reasonFrom(debug)}`);
  const described = (await debug.json()) as {
    data?: { granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> };
  };
  const scopes = described.data?.granular_scopes ?? [];
  const wabaId = scopes.find((s) => s.scope === "whatsapp_business_management")?.target_ids?.[0] ?? "";
  if (!wabaId) throw new Error("The sign-in granted no WhatsApp account. Run it again and choose the account.");

  const numbers = await fetch(`${GRAPH}/${encodeURIComponent(wabaId)}/phone_numbers`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!numbers.ok) throw new Error(`The account has no readable numbers: ${await reasonFrom(numbers)}`);
  const listed = (await numbers.json()) as { data?: Array<{ id?: string }> };
  const phoneNumberId = listed.data?.[0]?.id ?? "";
  if (!phoneNumberId) throw new Error("That WhatsApp account has no phone number on it yet.");
  return { wabaId, phoneNumberId };
}

/**
 * Subscribes this app to the account's events.
 *
 * Skipping it leaves the account readable and unsendable — templates and numbers answer,
 * and every send comes back "(#200) You do not have the necessary permissions", which names
 * neither the app nor the subscription.
 */
export async function subscribeMetaApp(token: string, wabaId: string): Promise<void> {
  const response = await fetch(`${GRAPH}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Signed in, but this app could not be subscribed to the account: ${await reasonFrom(response)}`);
}

/**
 * Writes the connection, its sealed credential and the channel.
 *
 * The phone number is deliberately never registered. On a coexistence onboarding it is
 * already live — running in someone's WhatsApp Business app, which is the reason to use this
 * flow at all — and registering it is what logs that person out and takes the chat history
 * on their device with it.
 */
export async function saveMetaConnection(args: {
  orgId: string;
  productId: string;
  token: string;
  wabaId: string;
  phoneNumberId: string;
}): Promise<string> {
  const db = await getDb();
  const endpointUrl = `${GRAPH}/${args.phoneNumberId}/messages`;
  const connectionId = new ObjectId();

  await db.collection(C.connections).insertOne({
    _id: connectionId,
    orgId: args.orgId,
    productId: args.productId,
    key: "http",
    provider: "meta",
    authType: "bearer",
    endpointUrl,
    waba: { id: args.wabaId, phoneNumberId: args.phoneNumberId },
    http: {
      endpointUrl,
      method: "POST",
      payloadTemplate: {
        messaging_product: "whatsapp",
        to: "$person.phoneDigits",
        type: "template",
        template: {
          name: "$template.name",
          // Meta matches the template's registered language and refuses a send where the
          // two differ, so every template on one connection shares this code.
          language: { code: "en" },
          components: [{ type: "body", parameters: "$template.paramTexts" }],
        },
      },
      // Free words inside the reply window go to the same endpoint as a different type.
      session: {
        payloadTemplate: {
          messaging_product: "whatsapp",
          to: "$person.phoneDigits",
          type: "text",
          text: { body: "$content.body" },
        },
      },
      messageIdPath: "$.messages.0.id",
      errorPaths: ["$.error.message"],
    },
    scopes: ["whatsapp_business_messaging", "whatsapp_business_management"],
    status: "healthy",
    directions: ["out", "in"],
    createdBy: args.orgId,
    createdAt: new Date(),
  });

  await db.collection(C.credentials).insertOne({
    _id: new ObjectId(),
    orgId: args.orgId,
    connectionId: String(connectionId),
    authType: "bearer",
    ...sealSecret(args.token),
    status: "verified",
  });

  await db.collection(C.channels).insertOne({
    _id: new ObjectId(),
    orgId: args.orgId,
    productId: args.productId,
    connectionId: String(connectionId),
    key: "whatsapp",
    kind: "native",
    capabilities: {
      send: true,
      html: false,
      trackingOpens: false,
      trackingClicks: false,
      bounceWebhook: false,
      // True where the hand-configured route leaves it false: this connection arrives with
      // the webhook subscribed, so replies and delivery really do come back.
      inboundReplies: true,
      consentRequired: true,
      windowRules: "24h",
      fromDomain: "caller_controlled",
    },
    // Meta's own floor for a business that is not verified yet, and the number this lands on
    // is usually one somebody is already talking to clients from.
    governor: { dailyCap: 250 },
    // Meta bans a number rather than filtering a message, and on a coexistence number the
    // ban takes a colleague's live client conversations with it.
    policy: { audience: ["warm_lead", "existing_user"] },
    status: "healthy",
    // Off until a human has seen a test send and its delivery receipt.
    enabled: false,
  });

  return String(connectionId);
}
