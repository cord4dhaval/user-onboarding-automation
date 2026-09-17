/**
 * Proves a pasted LinkedIn session works against Voyager, and exercises each write op with
 * that session, before any of it is wired into the engine. This is the ground-truth test
 * for method A.
 *
 *   1. Log in to LinkedIn in your own browser.
 *   2. DevTools → Application → Cookies → https://www.linkedin.com
 *      copy `li_at` and `JSESSIONID` (keep its quotes), and copy your user agent from
 *      DevTools → Network → any request → Request Headers → user-agent.
 *   3. Put them in the environment and run one of the commands below.
 *
 *   LI_AT=... LI_JSESSIONID='"ajax:123..."' LI_UA='Mozilla/5.0 ...' \
 *     npx tsx src/scripts/linkedin-check.ts <command>
 *
 * Commands:
 *   me                         — who the session is (read only)
 *   profile <slug>             — resolve a profile URL slug: provider id + your distance
 *   invite  <slug> [note...]   — SEND a connection invite (real; withdraw it after if you like)
 *   dm      <slug> [text...]   — SEND a direct message to a 1st-degree connection (real)
 *   comment <activityUrn> <text...>  — comment on a post (real). Reply by passing a
 *                                       urn:li:comment:(...) instead of the activity urn.
 *
 * The write commands really act on your account, so they are only run when named.
 */

import { readFileSync } from "node:fs";
import { LinkedInClient } from "../adapters/channel/linkedin/client.js";
import { SessionError, type LinkedInSession } from "../adapters/channel/linkedin/session.js";

/**
 * The session, from the environment or from a gitignored `.linkedin-session.json` at the
 * repo root — the file so the three values are pasted once, not re-typed per command:
 *
 *   { "li_at": "...", "jsessionid": "\"ajax:...\"", "userAgent": "Mozilla/5.0 ..." }
 */
function readSession(): LinkedInSession {
  const env = {
    li_at: process.env.LI_AT?.trim(),
    jsessionid: process.env.LI_JSESSIONID?.trim(),
    userAgent: process.env.LI_UA?.trim(),
  };
  if (env.li_at && env.jsessionid && env.userAgent) return env as LinkedInSession;

  try {
    const file = JSON.parse(readFileSync(".linkedin-session.json", "utf8")) as Partial<LinkedInSession>;
    if (file.li_at && file.jsessionid && file.userAgent) return file as LinkedInSession;
  } catch {
    /* fall through to the error below */
  }
  console.error(
    "No session found. Either set LI_AT / LI_JSESSIONID / LI_UA, or create .linkedin-session.json\n" +
      'at the repo root: { "li_at": "...", "jsessionid": "\\"ajax:...\\"", "userAgent": "..." }',
  );
  process.exit(1);
}

async function main() {
  const client = new LinkedInClient(readSession());
  const [command = "me", arg1, ...rest] = process.argv.slice(2);
  const text = rest.join(" ");

  // A target can be a profile-URL slug (resolved to a provider id) or a provider id given
  // directly (starts with `ACoAA` or `urn:li:fs`). Direct ids let the write ops be tested
  // while profileBySlug is on a dead endpoint (see below).
  const resolveTarget = async (arg: string): Promise<{ providerId: string; name: string }> => {
    if (/^urn:li:fs|^ACoAA/.test(arg)) return { providerId: arg, name: arg };
    const p = await client.profileBySlug(arg);
    return { providerId: p.providerId, name: `${p.firstName} ${p.lastName}` };
  };

  try {
    switch (command) {
      case "me": {
        const me = await client.me();
        console.log(`session OK — ${me.firstName} ${me.lastName} (@${me.publicIdentifier})`);
        console.log(`provider id: ${me.providerId}`);
        break;
      }
      case "raw": {
        if (!arg1) throw new Error("usage: raw <slug|providerId>");
        const data = await client.rawProfile(arg1);
        const s = JSON.stringify(data);
        console.log(`length: ${s.length}`);
        console.log(s.slice(0, 4000));
        break;
      }
      case "profile": {
        if (!arg1) throw new Error("usage: profile <slug>");
        const p = await client.profileBySlug(arg1);
        console.log(`${p.firstName} ${p.lastName} — ${p.headline ?? ""}`);
        console.log(`provider id: ${p.providerId}`);
        console.log(`distance: ${p.distance}  pendingInvitation: ${p.pendingInvitation}`);
        break;
      }
      case "invite": {
        if (!arg1) throw new Error("usage: invite <slug|providerId> [note...]");
        const t = await resolveTarget(arg1);
        const r = await client.sendInvite(t.providerId, text || undefined);
        console.log(`invite sent to ${t.name} — invitationUrn: ${r.invitationUrn || "(not in response)"}`);
        break;
      }
      case "dm": {
        if (!arg1) throw new Error("usage: dm <slug|providerId> [text...]");
        const t = await resolveTarget(arg1);
        const r = await client.sendMessage(t.providerId, text || "Hello");
        console.log(`message sent to ${t.name} — conversationUrn: ${r.conversationUrn || "(not in response)"}`);
        break;
      }
      case "comment": {
        if (!arg1 || !text) throw new Error("usage: comment <activityUrn|commentUrn> <text...>");
        const isReply = arg1.startsWith("urn:li:comment:");
        const r = isReply
          ? await client.comment("", text, arg1)
          : await client.comment(arg1, text);
        console.log(`${isReply ? "reply" : "comment"} posted — commentUrn: ${r.commentUrn || "(not in response)"}`);
        break;
      }
      default:
        throw new Error(`unknown command "${command}" — see the header of this file`);
    }
  } catch (err) {
    if (err instanceof SessionError) console.error(`session ${err.kind}: ${err.message}`);
    else console.error(`failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
