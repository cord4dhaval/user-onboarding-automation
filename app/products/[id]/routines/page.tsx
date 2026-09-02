import { redirect } from "next/navigation";

/** Routines are a tab of the Claude page now. Old links and bookmarks still land right. */
export default async function Routines({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/products/${id}/claude?tab=routines`);
}
