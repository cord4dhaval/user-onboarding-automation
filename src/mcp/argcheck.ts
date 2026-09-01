/**
 * Checks a tool call against the server's own inputSchema before it goes over the wire.
 *
 * A binding is a mapping a person wrote once, against a schema that can change under
 * them. Without this, a wrong field name or a missing required argument surfaces as a
 * provider error at send time, on one message, hours later — and providers vary wildly
 * in how much they say. The schema is already in hand at discovery, so the mistake can
 * be named exactly, at the moment it is made.
 *
 * Deliberately a subset of JSON Schema: required, type, and enum, plus a closed-object
 * check. Anything it does not recognise it allows through — a validator that blocks a
 * legitimate send because it met a keyword it had not been taught is worse than the
 * error it was trying to prevent.
 */

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  additionalProperties?: boolean | Schema;
};

const TYPE_NAMES: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  null: (v) => v === null,
};

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typeMismatch(spec: Schema, value: unknown): string | null {
  const declared = spec.type;
  if (!declared) return null;
  const allowed = Array.isArray(declared) ? declared : [declared];
  // An unrecognised type name is not a failure — it is a keyword this checker has not
  // been taught, and the server is the authority on its own schema.
  const known = allowed.filter((t) => t in TYPE_NAMES);
  if (known.length === 0) return null;
  if (known.some((t) => TYPE_NAMES[t]?.(value))) return null;
  return `expected ${known.join(" or ")}, got ${describe(value)}`;
}

/** Returns one message per problem, empty when the call is well formed. */
export function checkArgs(inputSchema: unknown, args: Record<string, unknown>): string[] {
  const schema = inputSchema as Schema | undefined;
  if (!schema || typeof schema !== "object") return [];

  const problems: string[] = [];
  const properties = schema.properties ?? {};

  for (const name of schema.required ?? []) {
    if (args[name] === undefined) {
      problems.push(`${name} is required but was not supplied`);
    }
  }

  for (const [name, value] of Object.entries(args)) {
    const spec = properties[name];
    if (!spec) {
      // Only complain about an unknown argument where the server has said it accepts no
      // others. Most schemas leave this open, and sending an extra field is harmless.
      if (schema.additionalProperties === false) {
        const accepted = Object.keys(properties);
        problems.push(
          `${name} is not an argument of this tool${accepted.length ? ` (it accepts ${accepted.join(", ")})` : ""}`,
        );
      }
      continue;
    }

    const mismatch = typeMismatch(spec, value);
    if (mismatch) problems.push(`${name}: ${mismatch}`);

    if (Array.isArray(spec.enum) && spec.enum.length > 0 && !spec.enum.includes(value as never)) {
      problems.push(`${name}: expected one of ${spec.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    }
  }

  return problems;
}

/** The required argument names a person still has to map, for a form to mark them. */
export function requiredArgs(inputSchema: unknown): string[] {
  const schema = inputSchema as Schema | undefined;
  return Array.isArray(schema?.required) ? schema.required.map(String) : [];
}
