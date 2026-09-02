import { redirect } from "next/navigation";

/** Logs are a tab of the Claude page now. Old links and bookmarks still land right. */
export default async function Logs({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ routine?: string }>;
}) {
  const { id } = await params;
  const { routine } = await searchParams;
  redirect(`/products/${id}/claude?tab=logs${routine ? `&routine=${routine}` : ""}`);
}
