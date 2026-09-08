import { redirect } from "next/navigation";

/** Assets moved under Brand. Anything already pointing here still lands in the right place. */
export default async function AssetsMoved({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/products/${id}/brand?tab=assets`);
}
