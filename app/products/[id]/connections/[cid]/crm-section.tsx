import type { Document } from "mongodb";
import { Power, PowerOff, Save, Wand2 } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import type { McpTool } from "@/mcp/client.js";
import { crmMap } from "@/schemas/crm.js";
import { proposeCrmMap } from "@/engine/crm/map.js";
import { ActionButton, SubmitButton } from "../../../../ui/kit";
import Select from "../../../../ui/select";
import { ist, istLong } from "../../../../ui/time";
import { proposeCrm, saveCrmSettings, setCrmBackfillGoal, setCrmEnabled } from "../../../../crm-actions";
import CrmDrawer from "./crm-drawer";

/**
 * CRM reading for one connection: whether it can, whether it is on, and how far it has got.
 *
 * Offered only where the tools look like a CRM — a way to find a lead and a way to list
 * its history — so a mail or ads connection never shows it.
 */
export default async function CrmSection({
  productId,
  connection,
  tools,
}: {
  productId: string;
  connection: Document;
  tools: McpTool[];
}) {
  const connectionId = String(connection._id);
  const crm = (connection.crm ?? {}) as {
    enabled?: boolean;
    map?: unknown;
    enabledAt?: Date;
    sync?: {
      status?: string;
      error?: string | null;
      lastRunAt?: Date;
      lastPollAt?: Date;
      cursor?: string;
      pending?: string[];
      rateLimitedUntil?: Date;
      backfillGoal?: string;
    };
  };
  const parsed = crmMap.safeParse(crm.map);
  const capable = parsed.success || proposeCrmMap(tools) !== null;
  if (!capable) return null;

  const intro = (
    <p className="sub">
      Reads what the sales team logs in this CRM — notes, calls, meetings, stage, won or lost — into our own copy, and
      shows it on each person&apos;s timeline and to Claude when it plans. Read-only: nothing is written to the CRM, and
      nothing about what we send changes. Switching it off stops the reading; what was already read stays.
    </p>
  );

  if (!parsed.success) {
    return (
      <>
        <h2>Sales CRM</h2>
        {intro}
        <div className="card crm-card">
          <p className="sub crm-sub">
            These tools look like a CRM. Draft a map from them first; nothing is read until you switch it on.
          </p>
          <div className="crm-actions">
            <ActionButton action={proposeCrm.bind(null, productId, connectionId)} icon={<Wand2 />} pendingLabel="Reading the tools…">
              Set up CRM reading
            </ActionButton>
          </div>
        </div>
      </>
    );
  }

  const map = parsed.data;
  const db = await getDb();
  const orgId = String(connection.orgId);
  const [links, rows, checked, people, goals] = await Promise.all([
    db
      .collection(C.crmLinks)
      .aggregate([{ $match: { orgId, connectionId } }, { $group: { _id: "$status", n: { $sum: 1 } } }])
      .toArray(),
    db.collection(C.crmActivity).countDocuments({ orgId, connectionId }),
    db.collection(C.people).countDocuments({ orgId, productId, [`crmChecked.${connectionId}`]: { $exists: true } }),
    db.collection(C.people).countDocuments({ orgId, productId }),
    db.collection(C.goals).find({ orgId, productId }).project({ key: 1, name: 1 }).toArray(),
  ]);
  const count = (status: string) => Number(links.find((l) => l._id === status)?.n ?? 0);
  const sync = crm.sync ?? {};
  const limited = sync.rateLimitedUntil && new Date(sync.rateLimitedUntil).getTime() > Date.now();

  return (
    <>
      <h2>Sales CRM</h2>
      {intro}
      <div className="card crm-card">
        <div className="crm-head">
          <strong>CRM reading</strong>
          <span className={`pill ${crm.enabled ? "ok" : ""}`}>{crm.enabled ? "on" : "off"}</span>
          {crm.enabled && sync.status ? (
            <span className={`pill ${sync.status === "ok" ? "ok" : "warm"}`}>{limited ? "paused: rate limited" : sync.status}</span>
          ) : null}
          <div className="spacer" />
          <CrmDrawer
            productId={productId}
            connectionId={connectionId}
            scope={JSON.stringify(map.scope)}
            projects={map.projects.join(", ")}
            map={JSON.stringify(map, null, 2)}
            action={saveCrmSettings}
            label="Edit"
          />
          <ActionButton
            action={proposeCrm.bind(null, productId, connectionId)}
            variant="ghost"
            size="sm"
            icon={<Wand2 />}
            pendingLabel="Reading the tools…"
          >
            Re-draft map
          </ActionButton>
          {crm.enabled ? (
            <ActionButton
              action={setCrmEnabled.bind(null, productId, connectionId, false)}
              variant="quiet"
              size="sm"
              icon={<PowerOff />}
              pendingLabel="Switching off…"
            >
              Switch off
            </ActionButton>
          ) : (
            <ActionButton
              action={setCrmEnabled.bind(null, productId, connectionId, true)}
              size="sm"
              icon={<Power />}
              pendingLabel="Switching on…"
            >
              Switch on
            </ActionButton>
          )}
        </div>

        <dl className="crm-facts">
          <dt>Tenant</dt>
          <dd>{Object.keys(map.scope).length ? <code>{JSON.stringify(map.scope)}</code> : "whatever this login sees"}</dd>
          <dt>Projects</dt>
          <dd>{map.projects.length ? `${map.projects.length} selected` : "all of them"}</dd>
          <dt>Tools</dt>
          <dd>
            find <code>{map.findByEmail.tool}</code> · history <code>{map.events.tool}</code>
            {map.notes ? <> · notes <code>{map.notes.tool}</code></> : null}
            {map.meetings ? <> · meetings <code>{map.meetings.tool}</code></> : null}
          </dd>
          <dt>People looked up</dt>
          <dd>{checked} of {people}</dd>
          <dt>Found in the CRM</dt>
          <dd>
            {count("linked")} linked
            {count("review") ? ` · ${count("review")} to confirm` : ""}
            {count("out_of_scope") ? ` · ${count("out_of_scope")} in other projects` : ""}
            {count("unmatched") ? ` · ${count("unmatched")} not ours` : ""}
          </dd>
          <dt>Activity kept</dt>
          <dd>{rows} rows</dd>
          <dt>Last read</dt>
          <dd title={istLong(sync.lastRunAt)}>
            {ist(sync.lastRunAt, "not yet")}
            {sync.lastPollAt ? ` · changes checked ${ist(sync.lastPollAt)}` : ""}
            {sync.pending?.length ? ` · ${sync.pending.length} records queued` : ""}
          </dd>
        </dl>
        {sync.error ? <div className="note warn">{sync.error}</div> : null}

        <form action={setCrmBackfillGoal} className="crm-actions">
          <input type="hidden" name="productId" value={productId} />
          <input type="hidden" name="connectionId" value={connectionId} />
          <span className="muted">Look up first:</span>
          <Select
            name="goal"
            value={sync.backfillGoal ?? ""}
            ariaLabel="Campaign to look up first"
            options={[
              { value: "", label: "Newest people first" },
              ...goals.map((g) => ({ value: String(g.key), label: String(g.name ?? g.key) })),
            ]}
          />
          <SubmitButton variant="ghost" size="sm" icon={<Save />} pendingLabel="Saving…">Save order</SubmitButton>
        </form>
        <p className="sub crm-sub">
          The engine looks everyone up a few at a time on its minute clock, after sending, and reads the CRM&apos;s change
          feed every ten minutes. A person added later is looked up within minutes of arriving.
        </p>
      </div>
    </>
  );
}
