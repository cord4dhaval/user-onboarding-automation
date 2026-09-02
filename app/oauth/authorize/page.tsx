import { redirect } from "next/navigation";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { getClient, issueCode } from "@/auth/oauth-server.js";
import { requireSession } from "../../tenant";
import { SubmitButton } from "../../ui/kit";

export const dynamic = "force-dynamic";

interface Query {
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

/**
 * The consent screen. Signing in is required first, which is what binds the resulting
 * token to a specific organisation — the whole point of running our own OAuth server
 * rather than handing out one shared key.
 */
export default async function Authorize({ searchParams }: { searchParams: Promise<Query> }) {
  const q = await searchParams;
  const session = await requireSession();

  const clientId = q.client_id ?? "";
  const redirectUri = q.redirect_uri ?? "";
  const challenge = q.code_challenge ?? "";

  const client = clientId ? await getClient(clientId) : null;
  const problems: string[] = [];
  if (!client) problems.push("Unknown client.");
  if (!challenge || q.code_challenge_method !== "S256") problems.push("This client did not send a valid PKCE challenge.");
  // An unregistered redirect target is the classic way tokens get stolen.
  if (client && !(client.redirectUris as string[]).includes(redirectUri)) {
    problems.push("That redirect address is not registered for this client.");
  }

  if (problems.length > 0) {
    return (
      <main className="auth">
        <h1>Cannot authorise</h1>
        <ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>
      </main>
    );
  }

  const db = await getDb();
  const [org, productCount] = await Promise.all([
    db.collection(C.organizations).findOne({ _id: { $eq: (await import("mongodb")).ObjectId.createFromHexString(session.orgId) } }),
    db.collection(C.products).countDocuments({ orgId: session.orgId }),
  ]);

  async function approve() {
    "use server";
    const s = await requireSession();
    const code = await issueCode({
      clientId,
      userId: s.userId,
      orgId: s.orgId,
      redirectUri,
      codeChallenge: challenge,
      scope: q.scope ?? "engine.read engine.write",
      resource: q.resource,
    });
    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (q.state) url.searchParams.set("state", q.state);
    redirect(url.toString());
  }

  async function deny() {
    "use server";
    const url = new URL(redirectUri);
    url.searchParams.set("error", "access_denied");
    if (q.state) url.searchParams.set("state", q.state);
    redirect(url.toString());
  }

  return (
    <main className="auth" style={{ maxWidth: 460 }}>
      <h1>Authorise access</h1>
      <p className="sub">
        <strong>{String(client?.clientName ?? "An application")}</strong> is asking to connect to your workspace.
      </p>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="label">It will be able to</div>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 14 }}>
          <li>Read leads, goals and message history in <strong>{String(org?.name ?? "your workspace")}</strong></li>
          <li>Classify people, write plans and compose messages</li>
          <li>Trigger sends that your own guardrails still govern</li>
        </ul>
        <div className="label" style={{ marginTop: 14 }}>It will never be able to</div>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 14 }}>
          <li>See any credential — channel keys and tokens stay inside the engine</li>
          <li>Reach another organisation&apos;s data</li>
        </ul>
      </div>

      <p className="sub">
        Signed in as {session.email} · {productCount} product{productCount === 1 ? "" : "s"}
      </p>

      <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
        <form action={approve}><SubmitButton pendingLabel="Authorising…">Authorise</SubmitButton></form>
        <form action={deny}><SubmitButton variant="ghost">Cancel</SubmitButton></form>
      </div>
    </main>
  );
}
