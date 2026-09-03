/**
 * Turning whatever a lead form collected into something you can say to a person.
 *
 * The name field is free text a stranger typed on a phone, and taking the first word of it
 * produced "Hi Dr," and "Hi HR," in real mail. A greeting is the first line of the first
 * message, so getting it wrong is the most visible mistake the system can make and the one
 * that most plainly says nobody read this before sending it.
 */

/** Titles people put in front of a name. Never the name itself. */
const HONORIFICS = new Set([
  "dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms.", "miss", "mx",
  "prof", "prof.", "professor", "sir", "madam", "md",
  "sri", "shri", "smt", "kum", "er", "ca", "cs", "adv", "advocate",
  "capt", "col", "maj", "lt", "rev", "fr", "pt", "eng",
]);

/**
 * Words that are a desk rather than a person. "Hi HR," reads as mail merge failing out
 * loud, and there is no first name hiding behind it to find.
 */
const NOT_A_PERSON = new Set([
  "hr", "admin", "administrator", "info", "sales", "support", "team", "owner",
  "manager", "office", "contact", "enquiry", "inquiry", "accounts", "billing",
  "marketing", "care", "help", "service", "director", "ceo", "founder", "the",
]);

/**
 * Capitalisation, but only where it is safe to touch.
 *
 * A name typed in caps lock is shouted back at the reader, and one typed in lower case
 * looks careless. Anything already mixed is left exactly as written: "McDonald", "deSouza"
 * and "O'Brien" are all correct as they stand, and a tidy-up would damage them.
 */
function tidyCase(word: string): string {
  const hasLower = /[a-z]/.test(word);
  const hasUpper = /[A-Z]/.test(word);
  if (hasLower && hasUpper) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * The name to greet someone by, or "there" when the field holds nothing usable.
 *
 * "there" is not a failure: "Hi there," is a normal way to open a message, and it is far
 * better than confidently addressing someone as their own job title.
 */
export function greetingName(fullName: string | undefined | null, fallback = "there"): string {
  const words = String(fullName ?? "")
    // Brackets and quotes are punctuation someone pasted in. An apostrophe is not:
    // O'Brien and D'Souza lose their first syllable without it.
    .replace(/[(){}[\]<>"]/g, " ")
    .split(/[\s,]+/)
    .filter(Boolean);

  for (const word of words) {
    const bare = word.toLowerCase().replace(/[.]/g, "");
    if (HONORIFICS.has(word.toLowerCase()) || HONORIFICS.has(bare)) continue;
    if (NOT_A_PERSON.has(bare)) continue;
    // A single letter is an initial, and an initial is not a greeting.
    if (bare.replace(/[^a-zÀ-ɏ]/gi, "").length < 2) continue;
    return tidyCase(word);
  }

  return fallback;
}

/** The whole name, cleaned the same way, for places that address someone in full. */
export function displayName(fullName: string | undefined | null, fallback = "there"): string {
  const words = String(fullName ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map(tidyCase);
  return words.length > 0 ? words.join(" ") : fallback;
}
