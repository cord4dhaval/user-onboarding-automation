import { ObjectId } from "mongodb";
import { getDb } from "../db/client.js";
import { COLLECTIONS as C } from "../db/collections.js";
import { linkedinSlug } from "./address.js";
import { notify } from "./notify.js";
import type { LinkedInFind } from "./linkedin.js";

/**
 * Where a lead's LinkedIn profile comes from when their record has none: Claude finds it by
 * searching (routine 6), a person confirms or corrects it on the lead page, or an older
 * search is imported. All three go through here, so the same rules hold whoever answers.
 *
 * The profile is the person's, not one campaign's: it is written as their `linkedin`
 * identity, which is what the send path addresses an invite to. How it was found stays
 * beside it in `linkedinFind`, so the lead page can say why this profile and who chose it.
 */

export type FindStatus = NonNullable<LinkedInFind["status"]>;

export interface SaveFindInput {
  orgId: string;
  productId: string;
  personId: string;
  status: FindStatus;
  /** The profile URL; required for everything but "none". */
  url?: string;
  why: string;
  /** What the match was judged on: the search result's title, the page's headline. */
  evidence?: string;
  by: NonNullable<LinkedInFind["by"]>;
  /** Tell the owner about an unsure match. Off for a bulk import, which says so once itself. */
  notifyOwner?: boolean;
  now?: Date;
}

export interface SaveFindResult {
  status: FindStatus;
  profile: string | null;
  /** Whether the lead can now be invited: their profile is set. */
  usable: boolean;
}

export class FindRefused extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("; "));
    this.name = "FindRefused";
  }
}

/** The canonical profile URL for a slug. */
export function profileUrl(slug: string): string {
  return `https://www.linkedin.com/in/${encodeURIComponent(slug)}`;
}

export async function saveLinkedInFind(input: SaveFindInput): Promise<SaveFindResult> {
  const db = await getDb();
  const now = input.now ?? new Date();
  const why = input.why.trim();
  const problems: string[] = [];
  if (!why) problems.push("say why, in one sentence");

  const person = await db
    .collection(C.people)
    .findOne({ _id: new ObjectId(input.personId), orgId: input.orgId, productId: input.productId }, { projection: { name: 1 } });
  if (!person) throw new FindRefused(["person not found"]);

  if (input.status === "none") {
    if (problems.length) throw new FindRefused(problems);
    const find: LinkedInFind = { status: "none", why, ...(input.evidence ? { evidence: input.evidence } : {}), at: now, by: input.by };
    await db.collection(C.people).updateOne({ _id: person._id }, { $set: { linkedinFind: find } });
    return { status: "none", profile: null, usable: false };
  }

  const raw = String(input.url ?? "").trim();
  const slug = /linkedin\.com\/in\//i.test(raw) ? linkedinSlug(raw) : "";
  if (!slug) problems.push("a profile URL looks like https://www.linkedin.com/in/<name>; a company page, a post or a search link is not a profile");
  if (input.by === "claude" && !String(input.evidence ?? "").trim()) problems.push("say what the match was judged on (the search result's title or headline)");

  // One profile is one person. Two leads sharing it means one of them is wrong, and the
  // invite would reach the same member twice under two names.
  if (slug) {
    const other = await db.collection(C.people).findOne(
      { orgId: input.orgId, productId: input.productId, _id: { $ne: person._id }, identities: { $elemMatch: { kind: "linkedin", value: slug } } },
      { projection: { name: 1 } },
    );
    if (other) problems.push(`that profile is already ${String(other.name ?? "another lead")}'s; two leads cannot share one`);
  }
  if (problems.length) throw new FindRefused(problems);

  const url = profileUrl(slug);
  const find: LinkedInFind = { status: input.status, url, why, ...(input.evidence ? { evidence: input.evidence } : {}), at: now, by: input.by };

  if (input.status === "unsure") {
    await db.collection(C.people).updateOne({ _id: person._id }, { $set: { linkedinFind: find } });
    if (input.notifyOwner === false) return { status: "unsure", profile: url, usable: false };
    await notify({
      orgId: input.orgId,
      productId: input.productId,
      severity: "action",
      dedupeKey: `linkedin:confirm-profile:${input.personId}`,
      title: `Check the LinkedIn profile found for ${String(person.name ?? "a lead")}`,
      body: `${why} Open the lead to use it, change it, or say they have none.`,
      href: `/products/${input.productId}/library/${input.personId}`,
    });
    return { status: "unsure", profile: url, usable: false };
  }

  // sure, likely, confirmed: this is their profile now. A corrected one replaces the old,
  // and the cached member id goes with it so the send path looks the new one up.
  await db.collection(C.people).updateOne({ _id: person._id }, { $pull: { identities: { kind: "linkedin" } } } as never);
  await db.collection(C.people).updateOne(
    { _id: person._id },
    {
      $push: { identities: { kind: "linkedin", value: slug, verified: input.status === "confirmed" } },
      $set: { linkedinFind: find },
    } as never,
  );
  await db.collection(C.people).updateOne(
    { _id: person._id, "linkedin.slug": { $exists: true, $ne: slug } },
    { $unset: { linkedin: "" } },
  );
  return { status: input.status, profile: url, usable: true };
}
