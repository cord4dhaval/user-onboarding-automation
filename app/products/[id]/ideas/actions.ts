"use server";

import { revalidatePath } from "next/cache";
import { ideasLoopOn, reviewInventedIdeas, setInventedIdeaStatus, type InventedIdea } from "@/engine/ideas.js";
import { requireSession } from "../../../tenant";

/** Runs the same review what_works runs, so a person can see a trial move without waiting for Maintain. */
export async function reviewTrialIdeas(productId: string) {
  if (!ideasLoopOn()) throw new Error("The ideas loop is switched off (IDEAS_LOOP=off).");
  const { orgId } = await requireSession();
  await reviewInventedIdeas(orgId, productId);
  revalidatePath(`/products/${productId}/ideas`);
}

const BY_HAND: Record<InventedIdea["status"], string> = {
  trial: "put back on trial by hand on the Ideas page",
  active: "made active by hand on the Ideas page",
  retired: "retired by hand on the Ideas page",
};

/** Retire an invented idea, or bring one back, with the reason kept on its row. */
export async function moveInventedIdea(productId: string, n: number, status: InventedIdea["status"]) {
  if (!ideasLoopOn()) throw new Error("The ideas loop is switched off (IDEAS_LOOP=off).");
  const { orgId } = await requireSession();
  await setInventedIdeaStatus({ orgId, productId, n, status, reason: BY_HAND[status] });
  revalidatePath(`/products/${productId}/ideas`);
}
