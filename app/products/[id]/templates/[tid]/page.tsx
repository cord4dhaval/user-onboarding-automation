import { ObjectId } from "mongodb";
import { ArrowLeft, Copy, Trash2 } from "lucide-react";
import { getDb } from "@/db/client.js";
import { COLLECTIONS as C } from "@/db/collections.js";
import { loadBrandKit } from "@/engine/brand.js";
import { renderTemplate, resolveBlocks, type MergeVars } from "@/engine/compose.js";
import { renderHtml } from "@/engine/html.js";
import { validate } from "@/engine/validate.js";
import {
  addTemplateBlock,
  deleteTemplate,
  duplicateTemplate,
  moveTemplateBlock,
  removeTemplateBlock,
  saveTemplateMeta,
  updateTemplateBlock,
} from "../../../../actions";
import ConfirmButton from "../../../../ui/confirm";
import ClaudeBadge from "../../../../ui/claude-badge";
import { ActionButton } from "../../../../ui/kit";
import { requireSession } from "../../../../tenant";
import BlockList from "./block-list";
import PreviewPanel from "./preview-panel";
import SettingsDrawer from "./settings-drawer";

export const dynamic = "force-dynamic";

export default async function TemplateEditor({ params }: { params: Promise<{ id: string; tid: string }> }) {
  const { id, tid } = await params;
  const { orgId } = await requireSession();
  const db = await getDb();

  const [template, product, kit] = await Promise.all([
    db.collection(C.templates).findOne({ _id: new ObjectId(tid), orgId, productId: id }),
    db.collection(C.products).findOne({ _id: new ObjectId(id), orgId }),
    loadBrandKit(orgId, id),
  ]);

  if (!template) {
    return (
      <main>
        <h1>Template not found</h1>
        <p className="empty">
          <strong>It may have been deleted.</strong>
          <a href={`/products/${id}/templates`}>Back to templates</a>
        </p>
      </main>
    );
  }

  const blocks = template.blocks as Record<string, unknown>[];
  const config = (product?.config ?? {}) as { website?: string; trialLinkTemplate?: string };
  const site = (config.website ?? "https://example.com").replace(/\/$/, "");
  const vars: MergeVars = {
    first_name: "Priya",
    full_name: "Priya Nair",
    company: "cloudnine",
    person_id: "sample",
    trial_link: (config.trialLinkTemplate ?? `${site}/start?p={{person_id}}`).replace("{{person_id}}", "sample"),
    opt_out_url: `${site}/unsubscribe?p=sample`,
  };

  const rendered = renderTemplate(blocks, vars);
  const constraints = template.constraints as { maxWords?: number; noClaims?: string[] } | undefined;
  const check = validate(rendered, {
    channelKey: String(template.channel),
    maxWords: constraints?.maxWords,
    noClaims: constraints?.noClaims,
  });

  const isEmail = String(template.channel) === "email";
  const sends = isEmail && String(template.format ?? "html") !== "text" ? "html" : "text";
  // Rendered whatever the format says. A template that sends as text still has an HTML
  // version, and seeing it is how you decide whether to switch.
  const html = isEmail ? renderHtml(resolveBlocks(blocks, vars), kit) : undefined;
  const name = String(template.name ?? template.key);

  return (
    <main>
      <a className="back" href={`/products/${id}/templates`}>
        <ArrowLeft size={14} /> Templates
      </a>

      <header className="page-head">
        <div>
          <h1>{name}</h1>
          <p className="meta">
            <code>{String(template.key)}</code>
            <span>{String(template.channel)}</span>
            <span className="pill accent">{sends === "html" ? "HTML" : "plain text"}</span>
            <span>{String(template.scope)}</span>
            {template.segmentKey ? <span>{String(template.segmentKey)}</span> : null}
            <a href={`/products/${id}/brand`}>brand kit</a>
          </p>
        </div>
        <div className="row">
          {template.createdBy === "claude" && <ClaudeBadge note="drafted" />}
          <span className={`pill ${template.status === "active" ? "ok" : ""}`}>{String(template.status)}</span>
          <SettingsDrawer
            productId={id}
            templateId={tid}
            action={saveTemplateMeta}
            isEmail={isEmail}
            current={{
              name,
              stage: String(template.stage),
              status: String(template.status),
              format: sends,
              maxWords: constraints?.maxWords,
              noClaims: constraints?.noClaims ?? [],
            }}
          />
          <ActionButton
            variant="quiet"
            size="sm"
            icon={<Copy />}
            action={duplicateTemplate.bind(null, id, tid)}
            pendingLabel="Copying"
          >
            Duplicate
          </ActionButton>
          <ConfirmButton
            title={`Delete ${name}?`}
            body="Gone for good. Messages already sent keep their own copy of what went out, so history is unaffected — but a touch still queued against this template has to be dealt with first."
            confirmLabel="Delete template"
            action={deleteTemplate.bind(null, id, tid)}
          />
        </div>
      </header>

      <div className="split">
        <section>
          <h2>Blocks</h2>
          <p className="sub">
            Fixed blocks are yours and never rewritten. Slots are what Claude fills per person, falling back to
            their own text when a touch fires before any session has run.
          </p>
          <BlockList
            productId={id}
            templateId={tid}
            blocks={blocks}
            onUpdate={updateTemplateBlock}
            onAdd={addTemplateBlock}
            onRemove={removeTemplateBlock.bind(null, id, tid)}
            onMove={moveTemplateBlock.bind(null, id, tid)}
          />
        </section>

        <section>
          <h2>Preview</h2>
          <p className="sub">
            Rendered against a sample lead, exactly as the engine would — fallbacks included, brand applied.
          </p>
          <PreviewPanel
            html={html}
            text={rendered.bodyMd}
            subject={rendered.subject}
            preheader={rendered.preheader}
            to="priya@cloudnine.dev"
            sends={sends}
          />
          <p className="stat-row">
            <span>{rendered.wordCount} words</span>
            {html && <span>{Math.round(html.length / 1024)}KB</span>}
            {check.ok ? (
              <span className="pill ok">would send</span>
            ) : (
              <span className="pill bad">blocked: {check.hardFails.join("; ")}</span>
            )}
            {check.softFails.length > 0 && <span className="pill warn">{check.softFails.join("; ")}</span>}
          </p>
        </section>
      </div>
    </main>
  );
}
