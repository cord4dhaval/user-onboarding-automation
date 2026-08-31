import type { McpClient } from "./client.js";

/**
 * A binding maps our adapter verbs onto whatever a given server happened to name its
 * tools. Claude proposes it from the discovered schemas; the user confirms it in the UI.
 * Because it is data, a new product with entirely different tool names needs no code.
 */
export interface VerbBinding {
  tool: string;
  /** Values are either literals or "$path" references resolved against the call context. */
  args: Record<string, string>;
  returns?: Record<string, string>;
  healthyIf?: string;
}

export type Binding = Record<string, VerbBinding>;

export interface CallContext {
  person?: Record<string, unknown>;
  content?: Record<string, unknown>;
  channel?: Record<string, unknown>;
  cursor?: string | null;
  [key: string]: unknown;
}

/** Reads "$person.email" or "$content.subject" out of the context; anything else is a literal. */
export function resolveRef(ref: string, ctx: CallContext): unknown {
  if (!ref.startsWith("$")) return ref;
  const parts = ref.slice(1).split(".");
  let cursor: unknown = ctx;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function pluck(payload: unknown, path: string): unknown {
  const parts = path.replace(/^\$\.?/, "").split(".");
  let cursor: unknown = payload;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export async function invoke(
  client: McpClient,
  binding: Binding,
  verb: string,
  ctx: CallContext,
): Promise<Record<string, unknown>> {
  const spec = binding[verb];
  if (!spec) throw new Error(`binding has no mapping for verb "${verb}"`);

  const args: Record<string, unknown> = {};
  for (const [name, ref] of Object.entries(spec.args)) {
    const value = resolveRef(ref, ctx);
    if (value !== undefined) args[name] = value;
  }

  const raw = await client.callTool(spec.tool, args);

  if (!spec.returns) return { raw };
  const mapped: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(spec.returns)) {
    mapped[name] = pluck(raw, path);
  }
  return mapped;
}
