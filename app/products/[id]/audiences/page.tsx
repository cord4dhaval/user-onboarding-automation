import { redirect } from "next/navigation";

/** Audiences are a tab of the Audience page now. Old links and bookmarks still land right. */
export default async function Audiences({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/products/${id}/library?tab=audiences`);
}
