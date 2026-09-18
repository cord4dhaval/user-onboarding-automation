/**
 * The values an approved provider template is sent with.
 *
 * WhatsApp outside the reply window sends a template Meta approved, by name, with its
 * variables filled in separately — the words around them are fixed. The template row maps
 * each of the provider's variable names to where its value comes from:
 *
 *   { "name": "first_name", "message": "message", "trial_path": "trial_path" }
 *
 * A value naming a merge variable takes that variable. A value starting with "=" is a
 * constant, written out: "=TeamGrid". Anything else is refused rather than sent as typed,
 * because a mapping to "message" on a message nobody wrote used to go out with the word
 * "message" in place of the paragraph.
 *
 * Meta refuses a variable that is empty, holds a line break or a tab, or has more than four
 * spaces in a row, and the provider may still answer "OK" to the request. So those are
 * checked here, before the send, and named in the reason.
 */
export function providerParams(
  mapping: Record<string, string>,
  vars: Record<string, string | undefined>,
): { params: Record<string, string> } | { problem: string } {
  const params: Record<string, string> = {};
  for (const [param, ref] of Object.entries(mapping)) {
    const raw = ref.startsWith("=") ? ref.slice(1) : vars[ref];
    if (raw === undefined) {
      return { problem: `the template's {{${param}}} takes "${ref}", and this message has no value for it` };
    }
    const value = String(raw).trim();
    if (!value) return { problem: `the template's {{${param}}} would be empty` };
    if (/[\n\t]/.test(value) || / {5,}/.test(value)) {
      return {
        problem: `the template's {{${param}}} has a line break, a tab or more than four spaces in a row, which WhatsApp refuses inside a variable`,
      };
    }
    params[param] = value;
  }
  return { params };
}

/**
 * A link as the part after its host — "register?p=…&s=…" — for a template button whose
 * address is fixed up to the host and takes the rest as a variable.
 */
export function pathAndQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname.replace(/^\//, "")}${parsed.search}`;
  } catch {
    return "";
  }
}
