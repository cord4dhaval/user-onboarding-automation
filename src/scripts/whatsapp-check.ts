/**
 * Proves a Meta WhatsApp connection can really send, before a campaign is pointed at it.
 *
 * It uses the connection the sign-in wrote: the sealed business token, the WABA and the
 * phone number id, read from the database exactly as the send path reads them. So a message
 * that arrives here is a message the engine can send, and a refusal here is the refusal a
 * campaign would have hit at 9am with a real lead on the other end.
 *
 *   npm run whatsapp:check                       — the connection, the number, the templates
 *   npm run whatsapp:check -- send 919274718574 teamgrid_intro_v1 "Dhaval"
 *   npm run whatsapp:check -- text 919274718574 Hello from the API
 *   npm run whatsapp:check -- register 123456
 *
 * `send` is a template message: the only thing WhatsApp accepts when nobody has written to
 * the number in the last 24 hours. `text` is free words, which only work inside that window
 * — use it after the phone has replied.
 *
 * A number is picked per run, so the same connection can be tested against a colleague's
 * phone without touching anything stored.
 */

import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { resolveSecret } from "../crypto/broker.js";

const GRAPH = "https://graph.facebook.com/v23.0";

type Connection = {
  _id: ObjectId;
  orgId: string;
  productId?: string;
  waba?: { id?: string; phoneNumberId?: string };
};

/**
 * The connection to test: the one named in WA_CONNECTION, or the newest Meta connection.
 *
 * Newest rather than only, because a second sign-in writes a second connection and the one
 * somebody just made is the one they mean to test.
 */
async function connectionToTest(): Promise<Connection> {
  const db = await getDb();
  const named = process.env.WA_CONNECTION;
  const found = named
    ? await db.collection(C.connections).findOne({ _id: new ObjectId(named) })
    : await db.collection(C.connections).find({ provider: "meta" }).sort({ createdAt: -1 }).limit(1).next();
  if (!found?.waba?.phoneNumberId) {
    throw new Error("No Meta WhatsApp connection with a phone number. Connect one on the channels page first.");
  }
  return found as unknown as Connection;
}

/** Graph, with the business token and this deployment's own error wording. */
async function graph(
  token: string,
  path: string,
  init?: { method: string; body: unknown },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${GRAPH}/${path}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init ? { "content-type": "application/json" } : {}),
    },
    body: init ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, body };
}

/**
 * The digits WhatsApp expects: country code and number, nothing else.
 *
 * A ten digit number is read as Indian and prefixed, because that is what gets typed here,
 * and the prefix is printed rather than assumed silently — a message sent to the wrong
 * country is a message somebody pays for and nobody receives.
 */
function phoneDigits(given: string): string {
  const digits = given.replace(/\D+/g, "");
  if (digits.length === 10) {
    console.log(`Read ${given} as +91${digits}. Pass the country code to send elsewhere.`);
    return `91${digits}`;
  }
  if (digits.length < 10) throw new Error(`${given} is not a phone number.`);
  return digits;
}

/** What Meta says went wrong, and what it means for this connection. */
function explain(body: Record<string, unknown>): string {
  const error = (body.error ?? {}) as { message?: string; code?: number; error_subcode?: number; error_data?: { details?: string } };
  const detail = error.error_data?.details ? ` — ${error.error_data.details}` : "";
  const said = `${error.message ?? "refused"}${detail}`;
  if (error.code === 133010 || /not registered/i.test(said)) {
    return `${said}\n\n  The number is not registered on Cloud API. It is still on the On-Premises platform,\n  which is where a BSP like WATI keeps it. Register it with:\n    npm run whatsapp:check -- register <6-digit-pin>\n  That takes the number over on Cloud API and ends the BSP's connection to it.`;
  }
  if (error.code === 131030) {
    return `${said}\n\n  The recipient is not on this app's allowed list. An app that has not been through App\n  Review can only message numbers added under WhatsApp → API Setup → To.`;
  }
  if (error.code === 132001 || /template name does not exist/i.test(said)) {
    return `${said}\n\n  The template name or its language does not match this WABA. Run the script with no\n  arguments to list what is approved, and note the language beside each one.`;
  }
  if (error.code === 200 || /permission/i.test(said)) {
    return `${said}\n\n  The token cannot act on this number. Check the app is still subscribed to the WABA and\n  that the sign-in granted messaging, not only management.`;
  }
  return said;
}

/** The connection, the number behind it, and every template that could be sent today. */
async function status(connection: Connection, token: string): Promise<void> {
  const waba = String(connection.waba?.id);
  const number = String(connection.waba?.phoneNumberId);

  console.log(`connection ${String(connection._id)}  waba ${waba}  number id ${number}`);

  const details = await graph(token, `${number}?fields=display_phone_number,verified_name,quality_rating,platform_type,code_verification_status,throughput`);
  console.log(details.ok ? `number     ${JSON.stringify(details.body)}` : `number     FAILED ${explain(details.body)}`);
  if (details.body.platform_type === "ON_PREMISE") {
    console.log("           This number is on the On-Premises platform. Cloud API sends will be refused");
    console.log("           until it is registered — see `register` below.");
  }

  const subscribed = await graph(token, `${waba}/subscribed_apps`);
  const apps = ((subscribed.body.data ?? []) as Array<{ whatsapp_business_api_data?: { name?: string; id?: string } }>)
    .map((row) => `${row.whatsapp_business_api_data?.name ?? "?"} (${row.whatsapp_business_api_data?.id ?? "?"})`)
    .join(", ");
  console.log(`subscribed ${apps || "NOBODY — replies and delivery reports will not arrive"}`);

  const templates = await graph(token, `${waba}/message_templates?fields=name,status,language,category&limit=50`);
  const rows = (templates.body.data ?? []) as Array<{ name: string; status: string; language: string; category: string }>;
  console.log(`templates  ${rows.length}`);
  for (const row of rows.filter((t) => t.status === "APPROVED")) {
    console.log(`  ${row.name}  ${row.language}  ${row.category}`);
  }
}

/**
 * Sends one template message, the way the engine sends a first touch.
 *
 * Body parameters are passed positionally, in the order the template declares them. A
 * template with no variables takes none.
 */
async function send(connection: Connection, token: string, to: string, name: string, params: string[]): Promise<void> {
  const number = String(connection.waba?.phoneNumberId);
  const waba = String(connection.waba?.id);

  // The language has to match what the template was approved in, not what it looks like:
  // Meta refuses en against an en_US template and says only that the template does not
  // exist, which reads as the wrong name.
  const templates = await graph(token, `${waba}/message_templates?fields=name,language,status&limit=50`);
  const rows = (templates.body.data ?? []) as Array<{ name: string; language: string; status: string }>;
  const match = rows.find((t) => t.name === name && t.status === "APPROVED");
  if (!match) {
    throw new Error(`No approved template called ${name} on this account. Run with no arguments to list them.`);
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name,
      language: { code: match.language },
      ...(params.length
        ? { components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }] }
        : {}),
    },
  };

  console.log(`sending ${name} (${match.language}) to ${to}`);
  const result = await graph(token, `${number}/messages`, { method: "POST", body: payload });
  if (!result.ok) throw new Error(explain(result.body));

  const messages = (result.body.messages ?? []) as Array<{ id?: string }>;
  console.log(`accepted. message id ${messages[0]?.id ?? "?"}`);
  console.log("Accepted means Meta took it, not that a phone showed it. Delivery arrives on the");
  console.log("webhook, so check the phone, or wire the webhook address from the channels page.");
}

/** Free words, which WhatsApp only accepts within 24 hours of the last message from them. */
async function text(connection: Connection, token: string, to: string, body: string): Promise<void> {
  const number = String(connection.waba?.phoneNumberId);
  const result = await graph(token, `${number}/messages`, {
    method: "POST",
    body: { messaging_product: "whatsapp", to, type: "text", text: { body } },
  });
  if (!result.ok) throw new Error(explain(result.body));
  const messages = (result.body.messages ?? []) as Array<{ id?: string }>;
  console.log(`accepted. message id ${messages[0]?.id ?? "?"}`);
}

/**
 * Registers the number on Cloud API with a two-step verification PIN.
 *
 * This is the step that moves a number off the On-Premises platform, and it is not a test:
 * it ends whatever was sending on that number before, which on a coexistence number means
 * the WhatsApp Business app on somebody's phone is signed out and its chat history stays on
 * that device. It only runs when named, never as part of a send.
 */
async function register(connection: Connection, token: string, pin: string): Promise<void> {
  if (!/^\d{6}$/.test(pin)) throw new Error("The PIN is six digits. Choose one and keep it — Meta asks for it again.");
  const number = String(connection.waba?.phoneNumberId);
  const result = await graph(token, `${number}/register`, {
    method: "POST",
    body: { messaging_product: "whatsapp", pin },
  });
  if (!result.ok) throw new Error(explain(result.body));
  console.log("registered on Cloud API. Send a template now to confirm.");
}

async function main(): Promise<void> {
  const [command = "status", ...rest] = process.argv.slice(2);
  const connection = await connectionToTest();
  const token = await resolveSecret(String(connection.orgId), String(connection._id), "whatsapp-check");

  if (command === "status") await status(connection, token);
  else if (command === "send") {
    const [to, name, ...params] = rest;
    if (!to || !name) throw new Error("send <number> <template> [parameter...]");
    await send(connection, token, phoneDigits(to), name, params);
  } else if (command === "text") {
    const [to, ...words] = rest;
    if (!to || !words.length) throw new Error("text <number> <words...>");
    await text(connection, token, phoneDigits(to), words.join(" "));
  } else if (command === "register") {
    await register(connection, token, rest[0] ?? "");
  } else {
    throw new Error(`Unknown command ${command}. One of: status, send, text, register.`);
  }
}

main().then(
  // Two Mongo clients are open by now, this script's and the broker's, and neither closes
  // itself. Without this the run finishes its work and then hangs on an idle socket.
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
