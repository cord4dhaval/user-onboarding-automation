import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import type { ProductConfig } from "../schemas/product.js";

/**
 * Builds the starter template set for a product from its config alone: one welcome per
 * suggested channel, plus a segment variant wherever a segment names a distinct pain.
 *
 * These are deterministic so a brand-new product can send its first touch immediately,
 * before any Claude session has run. Claude replaces and improves them later through
 * upsert_template; a human edits them in the template editor. Nothing here is final.
 */
export async function generateDefaultTemplates(
  orgId: string,
  productId: string,
  config: ProductConfig,
): Promise<number> {
  const db = await getDb();
  const firstProp = config.valueProps[0] ?? "get started in minutes";
  let written = 0;

  for (const suggestion of config.suggestedChannels) {
    const isShortForm = suggestion.key !== "email";

    const blocks: Record<string, unknown>[] = [];
    if (!isShortForm) {
      blocks.push({
        type: "subject",
        slot: "warm one-line welcome naming their company, under 55 characters",
        fallback: "{{first_name}}, your workspace is ready",
      });
    }
    blocks.push({ type: "text", fixed: "Hi {{first_name}}," });
    blocks.push({
      type: "slot",
      instruct: `Two sentences on what they can do in the first ten minutes. Tone: ${config.voice.tone}. No filler.`,
      fallback: isShortForm ? firstProp : `${firstProp}\n\nMost teams see something useful inside a day.`,
    });
    blocks.push({ type: "cta", fixed: "Get started", url: config.trialLinkTemplate });
    if (!isShortForm) blocks.push({ type: "system", fixed: "opt_out_block" });

    await db.collection(C.templates).updateOne(
      { orgId, productId, key: "welcome", channel: suggestion.key, scope: "product_default" },
      {
        $set: {
          orgId,
          productId,
          key: "welcome",
          channel: suggestion.key,
          stage: "first_touch",
          scope: "product_default",
          version: 1,
          blocks,
          constraints: {
            maxWords: isShortForm ? 45 : 140,
            readingLevel: config.voice.readingLevel,
            noClaims: config.constraints.forbiddenClaims,
          },
          assetIds: [],
          stats: { sent: 0, replied: 0, converted: 0, alpha: 1, beta: 1 },
          status: "active",
          createdBy: "claude",
        },
        $setOnInsert: { _id: new ObjectId() },
      },
      { upsert: true },
    );
    written++;

    // A segment whose pain differs enough to deserve its own opening gets a variant that
    // overrides the default through the cascade.
    for (const segment of config.segments) {
      if (!segment.preferredChannels.includes(suggestion.key)) continue;

      await db.collection(C.templates).updateOne(
        { orgId, productId, key: "welcome", channel: suggestion.key, scope: "segment", segmentKey: segment.key },
        {
          $set: {
            orgId,
            productId,
            key: "welcome",
            channel: suggestion.key,
            stage: "first_touch",
            scope: "segment",
            segmentKey: segment.key,
            version: 1,
            blocks: [
              ...(isShortForm
                ? []
                : [{
                    type: "subject",
                    slot: `hook on "${segment.pain}", under 55 characters`,
                    fallback: `{{first_name}} — about ${segment.pain}`,
                  }]),
              { type: "text", fixed: "Hi {{first_name}}," },
              {
                type: "slot",
                instruct: `Open on their pain: ${segment.pain}. Then how ${segment.useCase} addresses it. Pre-empt: ${segment.objections[0] ?? "setup effort"}.`,
                fallback: `${segment.useCase} — without the spreadsheet gymnastics.`,
              },
              { type: "cta", fixed: "Get started", url: config.trialLinkTemplate },
              ...(isShortForm ? [] : [{ type: "system", fixed: "opt_out_block" }]),
            ],
            constraints: {
              maxWords: isShortForm ? 45 : 140,
              readingLevel: config.voice.readingLevel,
              noClaims: config.constraints.forbiddenClaims,
            },
            assetIds: [],
            stats: { sent: 0, replied: 0, converted: 0, alpha: 1, beta: 1 },
            status: "active",
            createdBy: "claude",
          },
          $setOnInsert: { _id: new ObjectId() },
        },
        { upsert: true },
      );
      written++;
    }
  }

  return written;
}
