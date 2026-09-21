import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "../../db/client.js";
import { COLLECTIONS as C } from "../../db/collections.js";
import { McpClient } from "../../mcp/client.js";
import { pluck } from "../../mcp/binding.js";
import { schemasFor } from "../../mcp/schemas.js";
import { resolveSecret } from "../../crypto/broker.js";
import { crmMap, type CrmListCall, type CrmMap } from "../../schemas/crm.js";

/**
 * The only way the engine talks to a CRM.
 *
 * Every call is spaced out and retried on 429 here rather than at each call site, because
 * the CRM's rate limit is shared with everything else that uses the same connection — on
 * TeamGrid that includes sending mail — and a burst from a backfill that trips it stops
 * more than the backfill.
 */
export class RateLimited extends Error {}

/**
 * TeamGrid answered 429 within a few minutes at one call every 1.5s while its mail was also
 * being sent through the same token, so the floor is set well under that.
 */
const SPACING_MS = 3_000;
let lastCallAt = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface CrmConnection {
  orgId: string;
  productId: string;
  connectionId: string;
  map: CrmMap;
}

/**
 * An OAuth access token lives about an hour. A backfill outlives that, and a client holding
 * the token it opened with starts answering 401 halfway through — the broker refreshes a
 * token only when it is asked for one, so the client asks again on a schedule and on a 401.
 */
const RENEW_EVERY_MS = 20 * 60_000;

export class CrmClient {
  calls = 0;
  private openedAt = Date.now();

  constructor(
    private mcp: McpClient,
    readonly conn: CrmConnection,
    /**
     * How many times to wait out a 429. None inside the minute tick or a page action: a wait
     * of twenty seconds there spends the budget the tick has left for everything else, and
     * the tick will simply try again later. A terminal backfill can afford to wait.
     */
    private readonly retries = 0,
    private readonly spacingMs = SPACING_MS,
    private readonly renewer?: () => Promise<McpClient>,
  ) {}

  private async renew(): Promise<void> {
    if (!this.renewer) return;
    this.mcp = await this.renewer();
    this.openedAt = Date.now();
  }

  static async open(connectionId: string, opts: { retries?: number } = {}): Promise<CrmClient> {
    const db = await getDb();
    const connection = await db.collection(C.connections).findOne({ _id: new ObjectId(connectionId) });
    if (!connection?.serverUrl) throw new Error("connection has no server URL");
    const parsed = crmMap.safeParse(connection.crm?.map);
    if (!parsed.success) throw new Error("this connection has no CRM map yet");
    const orgId = String(connection.orgId);
    const schemas = await schemasFor(connectionId);
    const connect = async () =>
      new McpClient(String(connection.serverUrl), await resolveSecret(orgId, connectionId, "crm.sync"), schemas);
    return new CrmClient(
      await connect(),
      { orgId, productId: String(connection.productId), connectionId, map: parsed.data },
      opts.retries ?? 0,
      SPACING_MS,
      connect,
    );
  }

  private resolveArgs(args: Record<string, unknown>, ctx: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...this.conn.map.scope };
    for (const [name, ref] of Object.entries(args)) {
      const value = typeof ref === "string" && ref.startsWith("$") ? ctx[ref.slice(1)] : ref;
      if (value !== undefined && value !== null && value !== "") out[name] = value;
    }
    return out;
  }

  async call(tool: string, args: Record<string, unknown>, ctx: Record<string, unknown>): Promise<unknown> {
    const resolved = this.resolveArgs(args, ctx);
    if (Date.now() - this.openedAt > RENEW_EVERY_MS) await this.renew();
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const wait = lastCallAt + this.spacingMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();
      this.calls++;
      try {
        const raw = await this.mcp.callTool(tool, resolved);
        return typeof raw === "string" ? parseJson(raw) : raw;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/\b401\b/.test(message) && !renewed && this.renewer) {
          renewed = true;
          attempt--;
          await this.renew();
          continue;
        }
        if (!/\b429\b/.test(message)) throw err;
        if (attempt >= this.retries) throw new RateLimited(message);
        await sleep(20_000 * (attempt + 1));
      }
    }
  }

  /** Every page of a list call, up to `maxPages`. `more` says whether it stopped early. */
  async list(
    spec: CrmListCall,
    ctx: Record<string, unknown>,
    maxPages = 10,
  ): Promise<{ items: Record<string, unknown>[]; more: boolean }> {
    const items: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const args = cursor && spec.cursorArg ? { ...spec.args, [spec.cursorArg]: cursor } : spec.args;
      const answer = await this.call(spec.tool, args, ctx);
      const rows = pluck(answer, spec.items);
      if (Array.isArray(rows)) items.push(...(rows.filter((r) => r && typeof r === "object") as Record<string, unknown>[]));
      const next = spec.next ? pluck(answer, spec.next) : undefined;
      cursor = typeof next === "string" && next ? next : undefined;
      if (!cursor) return { items, more: false };
    }
    return { items, more: true };
  }
}

function parseJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return text;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return text;
  }
}

export const lowerEmail = (value: unknown): string =>
  typeof value === "string" && value.includes("@") ? value.trim().toLowerCase() : "";

/**
 * The last ten digits, which is the part of an Indian mobile number every system agrees on.
 * CRMs keep "+91 98…", "0098…", "98…" and, from a Meta import, "p:+9198…" — all one phone.
 */
export const phoneKey = (value: unknown): string => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
};

export const fingerprint = (...parts: unknown[]): string =>
  createHash("sha1").update(parts.map((p) => String(p ?? "")).join("|")).digest("hex").slice(0, 24);

export function dateOf(value: unknown): Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d;
}
