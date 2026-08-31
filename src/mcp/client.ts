import { createHash } from "node:crypto";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcEnvelope<T> {
  jsonrpc: "2.0";
  id?: number | string;
  result?: T;
  error?: { code: number; message: string };
}

/**
 * MCP client over streamable HTTP.
 *
 * Two things a naive JSON client gets wrong against a real server: responses arrive as
 * server-sent events rather than a JSON body, and every session must complete the
 * initialize handshake before any other request is accepted.
 */
export class McpClient {
  private sessionId?: string;
  private negotiatedVersion = PROTOCOL_VERSION;
  private initialized = false;
  private nextId = 1;

  constructor(
    private readonly serverUrl: string,
    private readonly token: string,
  ) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.token}`,
      "mcp-protocol-version": this.negotiatedVersion,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private async post(payload: unknown): Promise<Response> {
    return fetch(this.serverUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    await this.ensureInitialized();
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    if (!res.ok) {
      // Providers frequently echo the credential back in an error body, so report the
      // status and nothing else.
      throw new Error(`MCP ${method} failed: HTTP ${res.status}`);
    }
    const envelope = await readEnvelope<T>(res, id);
    if (envelope.error) throw new Error(`MCP ${method} error: ${envelope.error.message}`);
    if (envelope.result === undefined) throw new Error(`MCP ${method} returned no result`);
    return envelope.result;
  }

  /** Handshake, then the initialized notification. Both are required before any call. */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const id = this.nextId++;
    const res = await this.post({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "conversion-engine", version: "0.1.0" },
      },
    });

    if (!res.ok) {
      this.initialized = false;
      throw new Error(`MCP initialize failed: HTTP ${res.status}`);
    }

    // The server assigns the session on this response; every later request must carry it.
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;

    const envelope = await readEnvelope<{ protocolVersion?: string }>(res, id);
    if (envelope.error) {
      this.initialized = false;
      throw new Error(`MCP initialize error: ${envelope.error.message}`);
    }
    if (envelope.result?.protocolVersion) this.negotiatedVersion = envelope.result.protocolVersion;

    // A notification has no id and expects no result; 202 with an empty body is normal.
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.rpc<{ tools: McpTool[]; nextCursor?: string }>(
        "tools/list",
        cursor ? { cursor } : {},
      );
      tools.push(...(page.tools ?? []));
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.rpc<{ content?: unknown; structuredContent?: unknown; isError?: boolean }>(
      "tools/call",
      { name, arguments: args },
    );
    if (result.isError) throw new Error(`MCP tool "${name}" reported an error`);
    // Prefer the typed payload; fall back to the content blocks a server returns instead.
    return result.structuredContent ?? unwrapContent(result.content) ?? result;
  }
}

/**
 * Reads either a plain JSON body or a text/event-stream, returning the envelope whose id
 * matches the request. Servers interleave notifications and progress events on the same
 * stream, so matching on id rather than taking the first event matters.
 */
async function readEnvelope<T>(res: Response, id: number | string): Promise<JsonRpcEnvelope<T>> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();

  if (!contentType.includes("text/event-stream")) {
    if (!text.trim()) return { jsonrpc: "2.0", id };
    return JSON.parse(text) as JsonRpcEnvelope<T>;
  }

  let fallback: JsonRpcEnvelope<T> | undefined;
  for (const block of text.split(/\n\n/)) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) continue;

    let parsed: JsonRpcEnvelope<T>;
    try {
      parsed = JSON.parse(data) as JsonRpcEnvelope<T>;
    } catch {
      continue;
    }
    if (parsed.id === id) return parsed;
    if (parsed.result !== undefined || parsed.error) fallback ??= parsed;
  }

  if (fallback) return fallback;
  throw new Error("MCP response contained no usable event");
}

/** Tool results arrive as content blocks; pull JSON out of a text block when present. */
function unwrapContent(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: string }).text ?? "";
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return content;
}

/** Cheap drift detection: when this hash changes, rediscover and revalidate the binding. */
export function hashTools(tools: McpTool[]): string {
  const canonical = tools
    .map((t) => `${t.name}:${JSON.stringify(t.inputSchema)}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex");
}
