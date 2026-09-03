import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { resolveSecret } from "../crypto/broker.js";
import { McpClient } from "../mcp/client.js";
import { schemasFor } from "../mcp/schemas.js";
import { unsubscribePerson } from "./unsubscribe.js";

/**
 * Reads replies.
 *
 * Without this the loop only ever hears from people who click. A reply is the strongest
 * signal anyone sends us and the only one that arrives in words, and until now it landed in
 * a mailbox nothing was watching: someone answering "not now, ask in Q3" got the day-seven
 * message anyway, and someone answering "please stop" got it too.
 *
 * The provider exposes no list-messages tool. What it exposes is `get_email_tokens`, which
 * hands back Gmail access tokens for the org's connected mailboxes so the caller can query
 * Gmail directly. Its description invites the AI to do that. This runs in the engine
 * instead, because the first rule of this system is that Claude never sees a credential —
 * a token in a model's context is a token in a transcript. The engine fetches, and Claude
 * reads the events that come out.
 *
 * Everything here is deliberately model-free. Matching a From address to a person is
 * lookup, not judgement, and an unsubscribe is a legal obligation rather than an opinion —
 * so it is honoured in code, on this tick, without waiting for a routine to run.
 */

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface InboundSummary {
  mailboxes: number;
  examined: number;
  matched: number;
  recorded: number;
  unsubscribed: number;
  errors: string[];
}

/**
 * Phrases that mean "stop", with no room for a second reading.
 *
 * Bare "stop" is deliberately absent: "stop by any time" and "we can stop the trial" are
 * ordinary sentences, and suppressing on them would silently lose real leads. Everything
 * here has to be someone addressing us about the mail itself.
 */
const OPT_OUT = [
  /\bunsubscribe\b/i,
  /\bopt[\s-]?out\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  // The verb alone is not enough: "we had to stop sending our own newsletter" is someone
  // talking about their mail, not ours. It has to be aimed at us, so an object is required.
  /\bstop (emailing|mailing|sending|contacting|messaging)\b(?:\s+\w+){0,2}\s*\b(me|us|these|this|them)\b/i,
  /\bstop (the |these |those |your |all )*(emails?|mails?|messages?)\b/i,
  /\b(do not|don'?t) (contact|email|mail) me\b/i,
  /\bno longer wish to (receive|be contacted)\b/i,
];

/**
 * Exported because it is policy, not plumbing: the same judgement has to be available to
 * anything else that reads a person's words, and it is worth being able to test directly.
 */
export function looksLikeOptOut(text: string): boolean {
  return OPT_OUT.some((pattern) => pattern.test(text));
}

interface Mailbox {
  email: string;
  token: string;
}

/** The provider's shape is not guaranteed, so every plausible spelling is accepted. */
function readMailboxes(raw: unknown): Mailbox[] {
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : ((): unknown[] => {
        if (!raw || typeof raw !== "object") return [];
        for (const key of ["tokens", "mailboxes", "connections", "data", "results"]) {
          const value = (raw as Record<string, unknown>)[key];
          if (Array.isArray(value)) return value;
        }
        return [];
      })();

  const out: Mailbox[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const email = r.email ?? r.address ?? r.mailbox;
    const token = r.accessToken ?? r.access_token ?? r.token;
    if (typeof email === "string" && typeof token === "string" && token) {
      out.push({ email, token });
    }
  }
  return out;
}

function headerOf(payload: unknown, name: string): string {
  const headers = ((payload as { headers?: unknown } | null)?.headers ?? []) as Array<{
    name?: unknown;
    value?: unknown;
  }>;
  const hit = headers.find((h) => String(h.name ?? "").toLowerCase() === name.toLowerCase());
  return hit ? String(hit.value ?? "") : "";
}

/** "Priya Nair <priya@acme.com>" and "priya@acme.com" both have to resolve to the address. */
function addressIn(value: string): string {
  const angled = value.match(/<([^>]+)>/);
  return (angled?.[1] ?? value).trim().toLowerCase();
}

/**
 * The reply text, as far as the mailbox will give it up.
 *
 * A mailbox connected in metadata mode has no body to return, so the snippet Gmail supplies
 * either way is the floor. Recording that a reply exists, with its first two lines, beats
 * recording nothing and beats failing the poll.
 */
function bodyOf(message: Record<string, unknown>): string {
  const snippet = typeof message.snippet === "string" ? message.snippet : "";
  const parts: unknown[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const data = (n.body as { data?: unknown } | undefined)?.data;
    if (typeof data === "string" && String(n.mimeType ?? "").startsWith("text/plain")) parts.push(data);
    for (const child of (n.parts ?? []) as unknown[]) walk(child);
  };
  walk(message.payload);

  const decoded = parts
    .map((d) => {
      try {
        return Buffer.from(String(d), "base64url").toString("utf8");
      } catch {
        return "";
      }
    })
    .join("\n")
    .trim();

  return decoded || snippet;
}

/**
 * Everything the sender quoted back at us, removed.
 *
 * A reply carries the whole thread underneath it, and our own message ends with the word
 * "Unsubscribe". Scanning the raw body would suppress every single person who replied.
 */
export function newTextOnly(body: string): string {
  const lines = body.split("\n");
  const cut = lines.findIndex((line) =>
    /^\s*(>|On .* wrote:|-{2,}\s*Original Message|_{5,}|Not useful\?)/i.test(line),
  );
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n").trim();
}

async function gmail(path: string, token: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${GMAIL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

/**
 * One pass over every connected mailbox in the product's org.
 *
 * Bounded by `limit` and by a lookback window rather than a cursor: a message id we have
 * already recorded is skipped, so re-reading the same window costs a query and changes
 * nothing. That is cheaper to reason about than a cursor that can silently stall — which is
 * exactly how the lead poller ended up re-reading its own results for days.
 */
export async function pollReplies(
  orgId: string,
  productId: string,
  limit = 40,
): Promise<InboundSummary> {
  const summary: InboundSummary = {
    mailboxes: 0,
    examined: 0,
    matched: 0,
    recorded: 0,
    unsubscribed: 0,
    errors: [],
  };
  const db = await getDb();

  const channel = await db
    .collection(C.channels)
    .findOne({ orgId, productId, kind: "mcp", enabled: true });
  if (!channel) return summary;

  const connectionId = String(channel.connectionId);
  const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
  if (!connection?.serverUrl) return summary;

  // Nothing is attempted unless the provider actually offers the tool. A connection that
  // cannot hand out tokens is not an error, it is a product without reply reading.
  const binding = await db.collection(C.mcpBindings).findOne({ orgId, connectionId });
  const tools = ((binding?.discoveredTools ?? []) as Array<{ name?: unknown }>).map((t) => String(t.name));
  if (!tools.includes("get_email_tokens")) return summary;

  let mailboxes: Mailbox[];
  try {
    const secret = await resolveSecret(orgId, connectionId, "engine.inbound");
    const client = new McpClient(String(connection.serverUrl), secret, await schemasFor(connectionId));
    mailboxes = readMailboxes(await client.callTool("get_email_tokens", {}));
  } catch (err) {
    summary.errors.push(`token fetch: ${err instanceof Error ? err.message : String(err)}`);
    return summary;
  }
  summary.mailboxes = mailboxes.length;
  if (mailboxes.length === 0) return summary;

  const since = channel.lastInboundPollAt as Date | undefined;
  // A day of overlap on the first run, and an hour of it afterwards. Overlap is harmless
  // because ids are deduped, and it covers a tick that failed or a clock that drifted.
  const after = Math.floor(
    (since ? new Date(since).getTime() - 3_600_000 : Date.now() - 86_400_000) / 1000,
  );

  for (const mailbox of mailboxes) {
    let ids: string[];
    try {
      const list = await gmail(
        `/messages?q=${encodeURIComponent(`after:${after} -from:${mailbox.email}`)}&maxResults=${limit}`,
        mailbox.token,
      );
      ids = ((list?.messages ?? []) as Array<{ id?: unknown }>).map((m) => String(m.id)).filter(Boolean);
    } catch (err) {
      summary.errors.push(`${mailbox.email}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (ids.length === 0) continue;

    // Asked once for the whole batch rather than per message, because most of what a
    // mailbox returns is mail that has nothing to do with us.
    const known = new Set(
      (
        await db
          .collection(C.events)
          .find({ orgId, type: "reply_received", "payload.messageId": { $in: ids } })
          .project({ "payload.messageId": 1 })
          .toArray()
      ).map((e) => String((e.payload as { messageId?: unknown })?.messageId)),
    );

    for (const id of ids) {
      if (known.has(id)) continue;
      summary.examined++;

      const message =
        (await gmail(`/messages/${id}?format=full`, mailbox.token)) ??
        (await gmail(`/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, mailbox.token));
      if (!message) continue;

      const from = addressIn(headerOf(message.payload, "From"));
      if (!from) continue;

      const person = await db
        .collection(C.people)
        .findOne(
          { orgId, productId, "identities.value": from },
          { projection: { primaryEmail: 1, lifecycle: 1 } },
        );
      if (!person) continue;
      summary.matched++;

      const personId = String(person._id);
      const at = message.internalDate ? new Date(Number(message.internalDate)) : new Date();
      const text = newTextOnly(bodyOf(message));

      await db.collection(C.events).insertOne({
        orgId,
        productId,
        personId,
        type: "reply_received",
        ts: at,
        handled: false,
        payload: {
          messageId: id,
          mailbox: mailbox.email,
          from,
          subject: headerOf(message.payload, "Subject"),
          text,
        },
      });
      summary.recorded++;

      // Honoured here rather than left for a routine. A person who asked to be left alone
      // should not still be receiving mail because a scheduled session has not run yet, and
      // "did they mean it" is not a judgement worth a model call when they wrote the word.
      if (looksLikeOptOut(text)) {
        const result = await unsubscribePerson(personId, "replied asking to stop");
        if (result.found && !result.alreadyDone) summary.unsubscribed++;
      }
    }
  }

  await db
    .collection(C.channels)
    .updateOne({ _id: channel._id }, { $set: { lastInboundPollAt: new Date() } });

  return summary;
}
