import { ObjectId, type Document } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { renderTemplate, resolveBlocks, type ComposedContent } from "./compose.js";
import { renderHtml } from "./html.js";
import { loadBrandKit } from "./brand.js";
import { resolveTemplateFor } from "./templates.js";
import { mergeVarsFor } from "./vars.js";
import { assetsForRender } from "./assets.js";

/**
 * What a message that has not been rendered yet will say when it goes out.
 *
 * Copy written by a session is stored as `slotText` alone — the greeting, the call to
 * action and the opt-out block belong to the template and are added at send time. The
 * review screen was reading `bodyMd`, which is empty until that render happens, so every
 * message composed that way opened as a blank body with a subject above it: nothing to
 * approve on, and no sign that anything was missing.
 *
 * This renders the same way the sender does, from the same template and the same merge
 * variables, so the reviewer reads the real message. Tracking is deliberately left off —
 * a draft that may never be sent should not carry live redirect links.
 */
export async function previewContent(
  orgId: string,
  action: Document,
): Promise<Pick<ComposedContent, "subject" | "bodyMd"> & { bodyHtml?: string }> {
  const db = await getDb();
  const productId = String(action.productId);

  const [person, product, goalInstance] = await Promise.all([
    db.collection(C.people).findOne({ _id: new ObjectId(String(action.personId)) }),
    db.collection(C.products).findOne({ _id: new ObjectId(productId) }),
    db.collection(C.goalInstances).findOne({ _id: new ObjectId(String(action.goalInstanceId)) }),
  ]);
  if (!person) throw new Error("the person this message is addressed to is gone");

  // The same choice the sender makes: the id if the touch carried one, otherwise the rung
  // this person has climbed to.
  const template = action.templateId
    ? await db.collection(C.templates).findOne({ _id: new ObjectId(String(action.templateId)) })
    : await resolveTemplateFor({
        orgId,
        productId,
        channel: String(action.channel),
        segment: (person.belief as { segment?: string } | undefined)?.segment,
        touchesSpent: Number((goalInstance?.spent as { touches?: number } | undefined)?.touches ?? 0),
      });
  if (!template) throw new Error(`no active ${String(action.channel)} template for this product`);

  const vars = mergeVarsFor(person, product);
  const prior = action.content as Partial<ComposedContent> | undefined;
  // A reviewer has to see what they are approving, and half the decision on a message that
  // carries something is the thing it carries. Loaded the same way the sender loads it.
  const toRender = {
    ...prior,
    assets: await assetsForRender(orgId, productId, action.assetIds, template.blocks),
  };
  const content = renderTemplate(template.blocks as Record<string, unknown>[], vars, toRender);

  const channel = action.channelId
    ? await db.collection(C.channels).findOne({ _id: new ObjectId(String(action.channelId)) })
    : null;
  const caps = (channel?.capabilities ?? {}) as { html?: boolean };
  const wantsHtml = String(action.format ?? template.format ?? "html") !== "text";

  let bodyHtml: string | undefined;
  if (wantsHtml && String(action.channel) === "email" && caps.html !== false) {
    bodyHtml = renderHtml(
      resolveBlocks(template.blocks as Record<string, unknown>[], vars, toRender),
      await loadBrandKit(orgId, productId),
    );
  }

  return { subject: content.subject, bodyMd: content.bodyMd, bodyHtml };
}
